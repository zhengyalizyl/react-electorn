import { spawn } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import {
    buildRenderPlan,
    buildSrt,
    validateProject
} from '@magicut-react-demo/video-project';
import { loadProject } from '@magicut-react-demo/video-project/node';

import { PROJECT_FILE } from './project-store';

/**
 * 渲染导出：把工程真的渲成一个 mp4。
 *
 * ## 为什么命令不在这里拼
 *
 * 拼命令是纯计算（`buildRenderPlan`），单独测过——包括**真跑一遍 ffmpeg**
 * 的验收。这里只负责起进程、报进度、收尸。
 *
 * 两件事分开的收益在第一次出错时就兑现了：ffmpeg 报错时，
 * 我们能把"下的是什么指令"原样打出来，而不是对着一个 exit code 猜。
 *
 * ## 进度从哪来
 *
 * `-progress pipe:1` 让 ffmpeg 往 stdout 吐键值对，其中 `out_time_us`
 * 是**已经写出去多少时长**。拿它除以成片总长就是百分比。
 *
 * 不解析 stderr 里那行 `frame= ... time=`：那是给人看的格式，
 * 不同版本的空格和字段都不一样，解析它等于把稳定性押在格式上。
 */

export interface ExportProgress {
    /** 0–1。总时长是已知的，所以这是真进度，不是假动画 */
    ratio: number;
    /** 已经渲染到第几秒 */
    renderedMs: number;
    totalMs: number;
}

export interface ExportOptions {
    root: string;
    dirName: string;
    /** 输出文件绝对路径。由主进程的保存对话框给出，渲染层不碰路径 */
    outPath: string;
    ffmpeg?: string;
    onProgress?: ((progress: ExportProgress) => void) | undefined;
    signal?: AbortSignal | undefined;
}

export class ExportError extends Error {
    /** ffmpeg 的 stderr 尾巴。**真正的错因永远在这里** */
    readonly detail: string;

    constructor(message: string, detail: string) {
        super(message);
        this.name = 'ExportError';
        this.detail = detail;
    }
}

/** 目录名里不许出现路径分隔符或 `..`——否则读写会跑到工程根之外 */
function assertSafeDirName(dirName: string): void {
    if (
        dirName.length === 0 ||
        dirName.includes('/') ||
        dirName.includes('\\') ||
        dirName === '.' ||
        dirName === '..'
    ) {
        throw new Error(`非法的工程目录名：${dirName}`);
    }
}

/**
 * 从 `-progress` 的输出里取已渲染时长。
 *
 * ffmpeg 不同版本给的键不一样（`out_time_us` / `out_time_ms`），两个都认。
 * **单位坑**：`out_time_ms` 这个名字是历史遗留，它的值其实是**微秒**，
 * 和 `out_time_us` 一模一样。按名字当毫秒用的话进度会快一千倍。
 */
export function parseProgressChunk(chunk: string): number | null {
    let latest: number | null = null;
    for (const line of chunk.split('\n')) {
        const match = /^out_time_(?:us|ms)=(-?\d+)$/.exec(line.trim());
        if (!match) continue;
        const micros = Number(match[1]);
        if (Number.isFinite(micros) && micros >= 0) {
            latest = Math.round(micros / 1000);
        }
    }
    return latest;
}

export async function exportVideo(options: ExportOptions): Promise<string> {
    assertSafeDirName(options.dirName);

    const file = path.join(options.root, options.dirName, PROJECT_FILE);
    const { project } = await loadProject(file);

    /**
     * 渲染之前先过一遍九条不变量。
     *
     * 一份语义错乱的工程照样能拼出 ffmpeg 命令，跑出来的片子音画错位——
     * 而用户只会以为是渲染坏了。**在花掉几分钟编码之前**就说清楚。
     */
    const issues = validateProject(project);
    if (issues.length > 0) {
        throw new ExportError(
            '这份工程不合法，渲染出来的片子会错位',
            issues.map((issue) => issue.message).join('；')
        );
    }

    // 字幕写到临时文件：`buildRenderPlan` 是纯函数，不碰磁盘
    const workDir = await mkdtemp(path.join(tmpdir(), 'magicut-export-'));
    const srt = buildSrt(project);
    let subtitlePath: string | undefined;
    if (srt.trim() !== '') {
        subtitlePath = path.join(workDir, 'subtitles.srt');
        await writeFile(subtitlePath, srt, 'utf8');
    }

    const plan = buildRenderPlan(project, {
        outPath: options.outPath,
        ...(subtitlePath ? { subtitlePath } : {})
    });

    const bin = options.ffmpeg ?? 'ffmpeg';
    const args = ['-progress', 'pipe:1', '-nostats', ...plan.args];

    try {
        await new Promise<void>((resolve, reject) => {
            const child = spawn(bin, args, {
                stdio: ['ignore', 'pipe', 'pipe']
            });

            // stderr 可能很长，只留尾巴——真正的错因总在最后几行
            let tail = '';
            const keepTail = (text: string): void => {
                tail = `${tail}${text}`.slice(-4000);
            };

            child.stdout.setEncoding('utf8');
            child.stdout.on('data', (chunk: string) => {
                const renderedMs = parseProgressChunk(chunk);
                if (renderedMs === null) return;
                options.onProgress?.({
                    renderedMs,
                    totalMs: plan.durationMs,
                    ratio: Math.min(1, renderedMs / plan.durationMs)
                });
            });

            child.stderr.setEncoding('utf8');
            child.stderr.on('data', keepTail);

            const onAbort = (): void => {
                child.kill('SIGKILL');
            };
            options.signal?.addEventListener('abort', onAbort, { once: true });

            child.on('error', (error) => {
                options.signal?.removeEventListener('abort', onAbort);
                // 最常见的一种：机器上根本没装 ffmpeg。
                // 原样抛 ENOENT 的话用户只会看到一串看不懂的东西
                reject(
                    new ExportError(
                        `起不了 ffmpeg（${bin}）`,
                        error instanceof Error ? error.message : String(error)
                    )
                );
            });

            child.on('close', (code) => {
                options.signal?.removeEventListener('abort', onAbort);
                if (code === 0) {
                    resolve();
                    return;
                }
                if (options.signal?.aborted) {
                    reject(new ExportError('导出已取消', ''));
                    return;
                }
                reject(
                    new ExportError(
                        `ffmpeg 退出码 ${code}`,
                        // 把命令也带上：出错时最想知道的就是"到底下了什么指令"
                        `${tail}\n\n命令：${bin} ${args.join(' ')}`
                    )
                );
            });
        });
    } finally {
        // 临时字幕文件不留在盘上。删不掉也不该让一次成功的导出变成失败
        await rm(workDir, { recursive: true, force: true }).catch(
            () => undefined
        );
    }

    return options.outPath;
}
