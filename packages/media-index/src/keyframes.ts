import { mkdir } from 'node:fs/promises';
import path from 'node:path';

import type { FfmpegBinaries, RunOptions } from './ffmpeg';
import { DEFAULT_BINARIES, runBinary, runBinaryRaw } from './ffmpeg';
import type { Keyframe } from './types';

export interface KeyframeOptions {
    /**
     * 场景切变阈值，0~1，越小越敏感。
     *
     * 0.4 是实测下来比较稳的一档：再低会把镜头内的运镜、曝光波动也算成切变，
     * 抽出一堆几乎一样的帧；再高则整段慢节奏素材一个切变点都检不出来。
     */
    sceneThreshold: number;
    /** 常规抽帧间隔：默认每 2 秒 1 帧，兼顾内容覆盖度与 token 成本 */
    intervalMs: number;
    /** 短于这个时长算"短素材"，改用更密的间隔 */
    shortVideoMs: number;
    /** 短素材的抽帧间隔：每 1 秒 1 帧，保证细节充足 */
    shortIntervalMs: number;
    /**
     * 最多抽几张。**成本闸门**——每张都要进 B4 的多模态请求，
     * 一个 30 分钟的长片按 2 秒一帧是 900 张，不设上限等于直接烧钱。
     */
    maxCount: number;
    /** 场景切变点少于这个数就不用它们，退回定间隔——静止长镜头就是这种情况 */
    minCount: number;
    /** 关键帧降采样目标宽度，高度按比例取偶数 */
    width: number;
    /** JPEG 质量，ffmpeg 的 -q:v，2 最好 31 最差 */
    quality: number;
    /** 素材列表预览图的宽度。只用来显示，不进模型 */
    thumbnailWidth: number;
}

export const DEFAULT_KEYFRAME_OPTIONS: KeyframeOptions = {
    sceneThreshold: 0.4,
    intervalMs: 2000,
    shortVideoMs: 10_000,
    shortIntervalMs: 1000,
    maxCount: 20,
    minCount: 3,
    // 768×432 对视觉理解足够，再大只是多烧图像 token
    width: 768,
    quality: 2,
    thumbnailWidth: 200
};

/**
 * 用 ffprobe 的 lavfi 源做场景切变检测，返回切变时刻（毫秒）。
 *
 * 走 ffprobe 而不是 ffmpeg：这里只要时间戳不要图，ffprobe 直接吐结构化输出，
 * 不必去解析 ffmpeg 打在 stderr 上的 showinfo 日志。
 *
 * 为什么要这一步：均匀抽帧在"前 10 秒都是空镜、后 5 秒全是人物"的素材上
 * 会把一半的帧浪费在同一个画面上。按切变点取，**同样的张数能覆盖更多不同的内容**。
 * 检不出切变点（静止长镜头）时由 `planKeyframeTimes` 自动退回均匀抽帧。
 */
export async function detectSceneChanges(
    filePath: string,
    options: { threshold?: number; binaries?: FfmpegBinaries } & RunOptions = {}
): Promise<number[]> {
    const binaries = options.binaries ?? DEFAULT_BINARIES;
    const threshold =
        options.threshold ?? DEFAULT_KEYFRAME_OPTIONS.sceneThreshold;

    // movie= 的参数里 : 和 \ 是分隔符，必须转义，否则 Windows 盘符路径会被截断
    const escaped = filePath
        .replace(/\\/g, '\\\\')
        .replace(/:/g, '\\:')
        .replace(/'/g, "\\'");

    const { stdout } = await runBinary(
        binaries.ffprobe,
        [
            '-v',
            'error',
            '-f',
            'lavfi',
            '-i',
            `movie=${escaped},select=gt(scene\\,${threshold})`,
            '-show_entries',
            'frame=pts_time',
            '-print_format',
            'csv=p=0'
        ],
        options
    );

    return stdout
        .split('\n')
        .map((line) => Number.parseFloat(line.trim()))
        .filter((n) => Number.isFinite(n) && n >= 0)
        .map((sec) => Math.round(sec * 1000));
}

/**
 * 这段素材该抽几张。
 *
 * 短素材（< 10s）每秒 1 张，常规每 2 秒 1 张，再被 `maxCount` 截断。
 * 两档间隔是因为：3 秒的空镜按 2 秒一帧只有 1 张，几乎等于没看；
 * 而半小时的长片按 1 秒一帧要 1800 张，光图像 token 就上百万。
 */
export function planKeyframeCount(
    durationMs: number,
    options: KeyframeOptions = DEFAULT_KEYFRAME_OPTIONS
): number {
    if (durationMs <= 0) return 0;
    const interval =
        durationMs < options.shortVideoMs
            ? options.shortIntervalMs
            : options.intervalMs;
    return Math.max(
        1,
        Math.min(options.maxCount, Math.ceil(durationMs / interval))
    );
}

/**
 * 决定抽哪几个时刻。**纯函数**——抽帧策略的全部逻辑在这里，可以脱离 ffmpeg 单测。
 *
 * 策略：张数由时长按 `planKeyframeCount` 定；取点优先用场景切变点
 * （信息密度更高），切变点不足 `minCount` 时退到定间隔。
 * 两端各留一个边距：t=0 和 t=duration 上取帧经常是黑场或直接取不到。
 */
export function planKeyframeTimes(
    durationMs: number,
    sceneChangeMs: readonly number[],
    options: KeyframeOptions = DEFAULT_KEYFRAME_OPTIONS
): number[] {
    if (durationMs <= 0) return [];

    const margin = Math.min(250, Math.floor(durationMs / 10));
    const lo = margin;
    const hi = durationMs - margin;
    if (hi <= lo) return [Math.floor(durationMs / 2)];

    const target = planKeyframeCount(durationMs, options);
    const usable = [...new Set(sceneChangeMs)]
        .filter((t) => t >= lo && t <= hi)
        .sort((a, b) => a - b);

    let picked: number[];
    if (usable.length >= options.minCount) {
        picked = pickEvenly(usable, target);
    } else {
        // 定间隔回退：n 个点把 [lo, hi] 分成 n+1 段，取每段的分界
        const span = hi - lo;
        picked = Array.from(
            { length: target },
            (_, i) => lo + Math.round((span * (i + 1)) / (target + 1))
        );
    }

    return [...new Set(picked)].sort((a, b) => a - b).slice(0, target);
}

/** 从已排序数组里均匀取 count 个元素，两端都要保住 */
function pickEvenly(values: readonly number[], count: number): number[] {
    if (values.length <= count) return [...values];
    if (count === 1) {
        const mid = values[Math.floor(values.length / 2)];
        return mid === undefined ? [] : [mid];
    }
    const out: number[] = [];
    for (let i = 0; i < count; i += 1) {
        const value =
            values[Math.round((i * (values.length - 1)) / (count - 1))];
        if (value !== undefined) out.push(value);
    }
    return out;
}

/** 关键帧的落盘文件名。带上时刻，看目录就知道对应源片的哪一秒 */
export function keyframeFileName(segmentKey: string, atMs: number): string {
    return `${segmentKey}_${String(atMs).padStart(9, '0')}.jpg`;
}

/** 缩略图的落盘文件名。与关键帧同目录，靠后缀区分 */
export function thumbnailFileName(segmentKey: string): string {
    return `${segmentKey}_thumb.jpg`;
}

/** 3 字节 RGB → `#rrggbb`。拿不到 3 个字节就当没取到，不编一个假颜色出来 */
export function toHexColor(rgb: Uint8Array): string | null {
    if (rgb.length < 3) return null;
    return `#${[...rgb.subarray(0, 3)]
        .map((b) => b.toString(16).padStart(2, '0'))
        .join('')}`;
}

export interface ExtractOptions extends RunOptions {
    binaries?: FfmpegBinaries;
    quality?: number;
    width?: number;
}

/**
 * 按给定时刻抽帧并降采样落盘，顺带取回每帧的平均色。
 *
 * `-ss` 放在 `-i` **之前**是输入端快速定位（先跳再解码）；放后面是逐帧解码到目标时刻，
 * 在长素材上会慢几十倍。代价是精度受关键帧间隔影响——对"取一张代表画面"完全够用。
 *
 * 平均色走**同一次调用的第二路输出**：同一帧分出两条滤镜链，一条缩到目标宽度写 jpg，
 * 一条缩到 1×1（`flags=area`，即真·面积平均）以 rawvideo 写 stdout。
 * 另起一个进程去读刚写出的 jpg 也能算，但那是每帧多一次 spawn——
 * 20 帧的素材就是多 20 个进程，而并发池的名额本来就紧张。
 */
export async function extractKeyframes(
    filePath: string,
    timesMs: readonly number[],
    outDir: string,
    segmentKey: string,
    options: ExtractOptions = {}
): Promise<Keyframe[]> {
    if (timesMs.length === 0) return [];

    const binaries = options.binaries ?? DEFAULT_BINARIES;
    const width = options.width ?? DEFAULT_KEYFRAME_OPTIONS.width;
    const quality = options.quality ?? DEFAULT_KEYFRAME_OPTIONS.quality;

    await mkdir(outDir, { recursive: true });

    const out: Keyframe[] = [];
    for (const atMs of timesMs) {
        options.signal?.throwIfAborted();
        const target = path.join(outDir, keyframeFileName(segmentKey, atMs));
        const { stdout } = await runBinaryRaw(
            binaries.ffmpeg,
            [
                '-y',
                '-loglevel',
                'error',
                '-ss',
                (atMs / 1000).toFixed(3),
                '-i',
                filePath,
                '-filter_complex',
                // -2 让高度自动取最近的偶数，奇数高度会让部分编码器直接报错
                `[0:v]scale=${width}:-2[big];[0:v]scale=1:1:flags=area[avg]`,
                '-map',
                '[big]',
                '-frames:v',
                '1',
                '-q:v',
                String(quality),
                target,
                '-map',
                '[avg]',
                '-frames:v',
                '1',
                '-f',
                'rawvideo',
                '-pix_fmt',
                'rgb24',
                '-'
            ],
            options
        );
        out.push({ atMs, path: target, avgColor: toHexColor(stdout) });
    }
    return out;
}

export interface ThumbnailOptions extends RunOptions {
    binaries?: FfmpegBinaries;
    width?: number;
    quality?: number;
}

/**
 * 生成素材列表用的小预览图。
 *
 * **源是已经抽好的关键帧，不是原片**：那张图已经解码过一次、就在磁盘上、
 * 只有几十 KB，再缩一道几乎不花时间；回头去原片上重新 seek + 解码一帧，
 * 在 4K 长片上要慢上两个数量级，而这张图只是用来在列表里占 200px。
 */
export async function extractThumbnail(
    sourceImage: string,
    outDir: string,
    segmentKey: string,
    options: ThumbnailOptions = {}
): Promise<string> {
    const binaries = options.binaries ?? DEFAULT_BINARIES;
    const width = options.width ?? DEFAULT_KEYFRAME_OPTIONS.thumbnailWidth;
    const quality = options.quality ?? DEFAULT_KEYFRAME_OPTIONS.quality;

    await mkdir(outDir, { recursive: true });
    const target = path.join(outDir, thumbnailFileName(segmentKey));

    await runBinary(
        binaries.ffmpeg,
        [
            '-y',
            '-loglevel',
            'error',
            '-i',
            sourceImage,
            '-vf',
            `scale=${width}:-2`,
            '-frames:v',
            '1',
            '-q:v',
            String(quality),
            target
        ],
        options
    );
    return target;
}
