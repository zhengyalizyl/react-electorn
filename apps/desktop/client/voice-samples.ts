import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
    copyFile,
    mkdir,
    readFile,
    rm,
    stat,
    writeFile
} from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';

const run = promisify(execFile);

/**
 * 自定义音色库：用户自己传进来的人声样本。
 *
 * 选文件、校验真的是音频、量出时长、复制进库、列出来、试听、删掉——
 * 都是真的，关掉应用再打开还在。
 *
 * ## 这些样本就是音色本身，不是"训练素材"
 *
 * 合成走本地 IndexTTS2，而它是**零样本**克隆：不训练、不注册，
 * 每次合成都把参考音频和要念的文本一起发过去（见 `index-tts.ts`）。
 * 所以这里存下来的文件不是用完就能扔的中间产物，而是**每一次合成都要读**
 * 的输入——`samplePathOf` 就是合成那一侧取它的入口。
 *
 * ## 为什么把文件复制进库，而不是记住原路径
 *
 * 记路径的话，用户把桌面上那个录音删了、或者把文件夹改了名，库里这条就成了
 * 一个指向虚空的名字——而他完全不知道为什么"音色不见了"。
 * 既然叫"库"，文件就该归它管。上一条说的"每次合成都要读"更让这件事没得商量。
 */

export interface VoiceSample {
    id: string;
    /** 原始文件名，列表上显示它 */
    name: string;
    durationMs: number;
    sizeBytes: number;
    /** ISO 时间串，格式化交给渲染层 */
    addedAt: string;
}

/**
 * 单个样本的大小上限。
 *
 * 试听要把音频整个读进内存再以 data URL 过一次 IPC。几十 MB 的文件
 * 会让渲染进程卡住好几秒——而音色复刻本来也只需要十几秒人声。
 * 与其让它卡死，不如明确拒绝并说清楚。
 */
export const MAX_SAMPLE_BYTES = 10 * 1024 * 1024;

/**
 * 单个样本的大小下限。
 *
 * **太短的参考音频做不出音色。** 10KB 的 wav 连一秒都不到，零样本克隆
 * （IndexTTS2 每次合成都要读这份参考，见 `tts/index-tts.ts`）拿它当输入，
 * 出来的是一段四不像的声音——而**那种失败不报错**，用户只会觉得
 * "这个功能不好用"，根本想不到是自己选的素材太短。
 *
 * 截断的、写了一半的、只有文件头的空壳，也都落在这一档，一并挡掉。
 */
export const MIN_SAMPLE_BYTES = 10 * 1024;

/** 能收的音频后缀。界面上写的是 MP3 / WAV，这里放宽到常见几种 */
const AUDIO_EXTENSIONS = ['.mp3', '.wav', '.m4a', '.aac', '.flac', '.ogg'];

const INDEX_FILE = 'voice-samples.json';
const SAMPLE_DIR = 'voice-samples';

export interface SampleStoreOptions {
    /** 可写目录，通常是 Electron 的 userData */
    userDataDir: string;
    ffprobe?: string;
}

function indexPath(options: SampleStoreOptions): string {
    return path.join(options.userDataDir, INDEX_FILE);
}

function sampleDir(options: SampleStoreOptions): string {
    return path.join(options.userDataDir, SAMPLE_DIR);
}

/**
 * 读索引。
 *
 * **读坏了当成空库**，不抛错：一个手改坏的 JSON 不该让整个口播面板打不开。
 * 用户看到的应该是"库是空的"，而不是一片红。
 */
export async function listSamples(
    options: SampleStoreOptions
): Promise<VoiceSample[]> {
    try {
        const raw = await readFile(indexPath(options), 'utf8');
        const parsed: unknown = JSON.parse(raw);
        if (!Array.isArray(parsed)) return [];
        return parsed.filter(
            (item): item is VoiceSample =>
                typeof item === 'object' &&
                item !== null &&
                typeof (item as VoiceSample).id === 'string'
        );
    } catch {
        return [];
    }
}

async function writeIndex(
    options: SampleStoreOptions,
    samples: VoiceSample[]
): Promise<void> {
    await mkdir(options.userDataDir, { recursive: true });
    await writeFile(
        indexPath(options),
        `${JSON.stringify(samples, null, 4)}\n`,
        'utf8'
    );
}

/** 量时长，顺便确认它**真的是音频**——改个后缀名不算 */
export async function probeAudio(
    file: string,
    ffprobe = 'ffprobe'
): Promise<number> {
    let stdout: string;
    try {
        ({ stdout } = await run(ffprobe, [
            '-v',
            'error',
            '-select_streams',
            'a:0',
            '-show_entries',
            'stream=codec_type:format=duration',
            '-of',
            'json',
            file
        ]));
    } catch {
        throw new Error('这个文件读不出来，可能不是音频，也可能已经损坏');
    }

    const data = JSON.parse(stdout) as {
        streams?: { codec_type?: string }[];
        format?: { duration?: string };
    };

    if (!data.streams?.some((item) => item.codec_type === 'audio')) {
        throw new Error('这个文件里没有音频轨');
    }

    const seconds = Number(data.format?.duration);
    if (!Number.isFinite(seconds) || seconds <= 0) {
        throw new Error('量不出这个文件的时长');
    }
    return Math.round(seconds * 1000);
}

/**
 * 把一个文件收进库。
 *
 * 路径来自主进程自己开的对话框，所以不做越界校验——但**大小和格式要查**：
 * 用户完全可能挑到一个 2GB 的视频，或者一个改了后缀的文本。
 */
export async function addSample(
    options: SampleStoreOptions,
    sourcePath: string
): Promise<VoiceSample[]> {
    const ext = path.extname(sourcePath).toLowerCase();
    if (!AUDIO_EXTENSIONS.includes(ext)) {
        throw new Error(
            `不支持的格式 ${ext || '（没有后缀）'}，` +
                `收 ${AUDIO_EXTENSIONS.join(' / ')}`
        );
    }

    const info = await stat(sourcePath);
    if (info.size > MAX_SAMPLE_BYTES) {
        throw new Error(
            `文件太大（${Math.round(info.size / 1024 / 1024)}MB），` +
                `上限 ${MAX_SAMPLE_BYTES / 1024 / 1024}MB`
        );
    }
    // 下限同样要查：太短的参考音频克隆不出音色，而那种失败**不会报错**，
    // 只会出一段四不像的声音（见 MIN_SAMPLE_BYTES）
    if (info.size < MIN_SAMPLE_BYTES) {
        throw new Error(
            `文件太小（${Math.max(1, Math.round(info.size / 1024))}KB），` +
                `至少 ${MIN_SAMPLE_BYTES / 1024}KB——` +
                `太短的音频克隆不出音色，建议录十几秒清晰人声`
        );
    }

    const durationMs = await probeAudio(sourcePath, options.ffprobe);

    // 按**路径 + 大小**取 id：同一个文件重复添加会落到同一条，不会堆出一串重复
    const id = `vs_${createHash('sha256')
        .update(`${sourcePath}:${info.size}`)
        .digest('hex')
        .slice(0, 12)}`;

    await mkdir(sampleDir(options), { recursive: true });
    await copyFile(sourcePath, path.join(sampleDir(options), `${id}${ext}`));

    const sample: VoiceSample = {
        id,
        name: path.basename(sourcePath),
        durationMs,
        sizeBytes: info.size,
        addedAt: new Date().toISOString()
    };

    const existing = await listSamples(options);
    const next = [sample, ...existing.filter((item) => item.id !== sample.id)];
    await writeIndex(options, next);
    return next;
}

export async function removeSample(
    options: SampleStoreOptions,
    id: string
): Promise<VoiceSample[]> {
    const existing = await listSamples(options);
    const target = existing.find((item) => item.id === id);

    const next = existing.filter((item) => item.id !== id);
    await writeIndex(options, next);

    // 索引先改、文件后删：反过来的话删文件成功而写索引失败，
    // 库里就留着一条指向不存在文件的记录
    if (target) {
        for (const ext of AUDIO_EXTENSIONS) {
            await rm(path.join(sampleDir(options), `${id}${ext}`), {
                force: true
            }).catch(() => undefined);
        }
    }
    return next;
}

/**
 * 一条样本的音频文件在哪。库里没有、或文件已经不在了都返回 null。
 *
 * **路径由命名规则算出来，不存进索引**：索引里存绝对路径的话，
 * userData 换了位置（换机器、改配置）那条路径就全是错的，
 * 而音频本身还好端端躺在新位置。
 *
 * 这是合成那一侧唯一的入口——`makeVoiceProvider` 的 `referenceOf` 就接在这儿。
 * 返回 null 时合成会当场拒绝并说"参考音频找不到"，而不是把 null 发出去。
 */
export async function samplePathOf(
    options: SampleStoreOptions,
    id: string
): Promise<string | null> {
    const samples = await listSamples(options);
    const sample = samples.find((item) => item.id === id);
    if (!sample) return null;

    const file = path.join(
        sampleDir(options),
        `${id}${path.extname(sample.name).toLowerCase()}`
    );

    try {
        await stat(file);
        return file;
    } catch {
        // 索引里有、文件没了：当成没有，别让下游拿着一个读不开的路径去合成
        return null;
    }
}

/**
 * 读出来给渲染层试听。
 *
 * 和试听音色一样走 data URL：**渲染层拿不到也不该拿到本地路径**。
 */
export async function readSample(
    options: SampleStoreOptions,
    id: string
): Promise<{ dataUrl: string; durationMs: number }> {
    const samples = await listSamples(options);
    const sample = samples.find((item) => item.id === id);
    if (!sample) throw new Error(`库里没有这个样本：${id}`);

    const ext = path.extname(sample.name).toLowerCase();
    const file = path.join(sampleDir(options), `${id}${ext}`);
    const bytes = await readFile(file);

    const mime =
        ext === '.wav'
            ? 'audio/wav'
            : ext === '.flac'
              ? 'audio/flac'
              : ext === '.ogg'
                ? 'audio/ogg'
                : 'audio/mpeg';

    return {
        dataUrl: `data:${mime};base64,${bytes.toString('base64')}`,
        durationMs: sample.durationMs
    };
}
