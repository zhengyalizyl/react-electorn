import { cpus } from 'node:os';

import type { MediaIndexDb } from './db';
import type { FfmpegBinaries } from './ffmpeg';
import { assertBinariesAvailable, DEFAULT_BINARIES } from './ffmpeg';
import type { KeyframeOptions } from './keyframes';
import {
    DEFAULT_KEYFRAME_OPTIONS,
    detectSceneChanges,
    extractKeyframes,
    extractThumbnail,
    planKeyframeTimes
} from './keyframes';
import { probeMediaFile } from './probe';
import { scanMediaDirectory } from './scan';
import type { IndexEvent, IndexSummary, MediaFileRecord } from './types';

/**
 * 同时允许几个文件在跑。
 *
 * **CPU 核数的一半**：每个名额背后都是一个 ffmpeg/ffprobe 子进程，而 ffmpeg
 * 自己就是多线程的。开满核数只会让这些进程互相抢 CPU 和磁盘带宽，总吞吐不升反降，
 * 还把整台机器拖到卡顿——用户这时候多半正在前台剪片子。留一半给系统和界面。
 */
export const DEFAULT_CONCURRENCY = Math.max(1, Math.floor(cpus().length / 2));

export interface IndexPipelineOptions {
    /** 素材扫描根目录。来自配置，不写死——打包后由用户在界面上选 */
    roots: readonly string[];
    db: MediaIndexDb;
    /** 关键帧与缩略图落盘目录 */
    keyframeDir: string;
    /** 并发文件数。默认 CPU 核数的一半；机械硬盘上建议再降 */
    concurrency?: number;
    binaries?: FfmpegBinaries;
    extensions?: readonly string[];
    keyframes?: Partial<KeyframeOptions>;
    signal?: AbortSignal;
    onEvent?: (event: IndexEvent) => void;
    /** 本轮扫描根目录下、已从磁盘消失的文件，是否从索引里清掉。默认 true */
    pruneMissing?: boolean;
}

function messageOf(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

function isAbort(error: unknown): boolean {
    return (
        error instanceof Error &&
        (error.name === 'AbortError' || error.name === 'TimeoutError')
    );
}

/**
 * 跑一遍索引：扫描 → 探测 → 抽帧 → 建片段。
 *
 * ## 增量与续跑靠同一个机制
 *
 * 没有单独的"断点文件"。每个文件的探测结果、关键帧、片段**在一个事务里落库**，
 * 未处理完的文件状态停在 `pending`。于是：
 *
 * - 第二次运行：`size:mtime` 没变且状态是 `ok` 的文件直接跳过
 * - 中途被 kill：没提交的文件仍是 `pending`，下次自然被捡起来重做
 * - 磁盘上没了的文件：本轮没扫到，从索引里清掉
 *
 * 三件事是同一套判据，不会出现"增量对了但续跑漏了"的分裂。全量扫一个几千文件的
 * 目录要几分钟，而这样一轮日常扫描只有 stat + 读 16 字节文件头，是秒级的。
 *
 * ## 失败不阻塞
 *
 * 单个文件探测或抽帧失败会落 `failed` 并继续下一个。3000 个素材里混进一个坏文件，
 * 不该让整轮索引停下——但也不能静默吞掉，所以失败原因进库、进事件流。
 */
export async function runIndexPipeline(
    options: IndexPipelineOptions
): Promise<IndexSummary> {
    const {
        roots,
        db,
        keyframeDir,
        concurrency = DEFAULT_CONCURRENCY,
        binaries = DEFAULT_BINARIES,
        signal,
        onEvent
    } = options;

    const keyframeOptions: KeyframeOptions = {
        ...DEFAULT_KEYFRAME_OPTIONS,
        ...options.keyframes
    };
    const emit = (event: IndexEvent): void => onEvent?.(event);

    const summary: IndexSummary = {
        scanned: 0,
        added: 0,
        changed: 0,
        skipped: 0,
        rejected: 0,
        pruned: 0,
        probed: 0,
        keyframed: 0,
        failed: 0,
        aborted: false
    };

    // 先确认工具链可用。3000 个文件跑到一半才发现没装 ffmpeg 是最糟的失败方式
    await assertBinariesAvailable(binaries);

    // ── 扫描 ──────────────────────────────────────────────────────────────
    emit({
        type: 'scan_started',
        roots: [...roots],
        lastScanAt: db.getLastScanAt()
    });
    const scanned = await scanMediaDirectory(roots, {
        ...(options.extensions ? { extensions: options.extensions } : {}),
        ...(signal ? { signal } : {}),
        onRejected: (path, reason) => {
            summary.rejected += 1;
            emit({ type: 'file_rejected', path, reason });
        }
    });
    summary.scanned = scanned.length;

    const todo: MediaFileRecord[] = [];
    db.transaction(() => {
        for (const file of scanned) {
            const { status } = db.upsertScannedFile(file);
            if (status === 'added') summary.added += 1;
            if (status === 'changed') summary.changed += 1;

            const record = db.getFileByPath(file.path);
            if (!record) continue;
            // 只要还有阶段没做完就重新排队。'failed' 不重排——坏文件不该每轮都重试一遍
            if (
                record.probeState === 'pending' ||
                record.keyframeState === 'pending'
            ) {
                todo.push(record);
            } else {
                summary.skipped += 1;
                emit({
                    type: 'file_skipped',
                    path: file.path,
                    reason: 'unchanged'
                });
            }
        }
        if (options.pruneMissing !== false) {
            summary.pruned = db.pruneMissing(
                roots,
                new Set(scanned.map((f) => f.path))
            );
        }
        // 与本轮的增量结果同一个事务：时间戳落了但文件没落，下一轮就会把
        // 这批文件当成"上次扫过了"
        db.setLastScanAt(Date.now());
    });
    emit({
        type: 'scan_finished',
        found: summary.scanned,
        added: summary.added,
        changed: summary.changed,
        pruned: summary.pruned,
        rejected: summary.rejected
    });

    // ── 逐文件处理 ────────────────────────────────────────────────────────
    //
    // 固定大小的 worker 池：每个 worker 领一个文件、做完再领下一个。
    // 用池而不是 `Promise.all(todo.map(...))`——后者会在一瞬间把几千个
    // ffmpeg 全拉起来，内存和 CPU 直接打满，系统卡死。
    let cursor = 0;
    let done = 0;

    const worker = async (): Promise<void> => {
        for (;;) {
            if (signal?.aborted) return;
            const index = cursor;
            cursor += 1;
            const record = todo[index];
            if (!record) return;

            done += 1;
            emit({
                type: 'file_started',
                path: record.path,
                done,
                total: todo.length
            });

            try {
                await processOne(record, {
                    db,
                    keyframeDir,
                    binaries,
                    keyframeOptions,
                    ...(signal ? { signal } : {}),
                    emit,
                    summary
                });
            } catch (error) {
                if (isAbort(error)) return;
                // processOne 内部已按阶段落库并发事件，这里兜住意料之外的异常，不让整轮崩掉
                summary.failed += 1;
                emit({
                    type: 'file_failed',
                    path: record.path,
                    stage: 'probe',
                    message: messageOf(error)
                });
            }
        }
    };

    await Promise.all(
        Array.from(
            { length: Math.max(1, Math.min(concurrency, todo.length || 1)) },
            () => worker()
        )
    );

    summary.aborted = signal?.aborted ?? false;
    emit({ type: 'finished', summary });
    return summary;
}

interface ProcessContext {
    db: MediaIndexDb;
    keyframeDir: string;
    binaries: FfmpegBinaries;
    keyframeOptions: KeyframeOptions;
    signal?: AbortSignal;
    emit: (event: IndexEvent) => void;
    summary: IndexSummary;
}

async function processOne(
    record: MediaFileRecord,
    ctx: ProcessContext
): Promise<void> {
    const { db, binaries, signal } = ctx;
    const runOptions = { binaries, ...(signal ? { signal } : {}) };

    // ── 探测 ──
    let probe = record.probe;
    if (record.probeState !== 'ok' || probe === null) {
        try {
            probe = await probeMediaFile(record.path, {
                ...runOptions,
                // 扫描时按扩展名的初判。`.mp4` 与 `.m4a` 容器一样，
                // 魔数分不出，这里让 ffprobe 拿着初判按流构成定夺
                kind: record.kind
            });
        } catch (error) {
            if (isAbort(error)) throw error;
            db.transaction(() => db.failProbe(record.id, messageOf(error)));
            ctx.summary.failed += 1;
            ctx.emit({
                type: 'file_failed',
                path: record.path,
                stage: 'probe',
                message: messageOf(error)
            });
            return;
        }
        db.transaction(() => db.saveProbe(record.id, probe!));
        ctx.summary.probed += 1;
    }

    // ── 抽帧 ──
    let frameCount = db.listKeyframes(record.id).length;
    if (record.keyframeState !== 'ok') {
        try {
            const times = await planTimes(record, probe, ctx, runOptions);
            const segmentKey = segmentKeyOf(record.id);
            const frames = await extractKeyframes(
                record.path,
                times,
                ctx.keyframeDir,
                segmentKey,
                {
                    width: ctx.keyframeOptions.width,
                    quality: ctx.keyframeOptions.quality,
                    ...runOptions
                }
            );
            frameCount = frames.length;

            // 列表预览图从第一张关键帧缩出来，源片不用再解码一次。
            // 纯音频没有画面，frames 是空的，这里自然就跳过了
            const first = frames[0];
            const thumbnail = first
                ? await extractThumbnail(
                      first.path,
                      ctx.keyframeDir,
                      segmentKey,
                      {
                          width: ctx.keyframeOptions.thumbnailWidth,
                          quality: ctx.keyframeOptions.quality,
                          ...runOptions
                      }
                  )
                : null;

            // 关键帧与片段一起提交：抽帧成功但片段没建，会让 B4 找不到要打标的对象
            db.transaction(() => {
                db.saveKeyframes(record.id, frames);
                if (thumbnail) db.saveThumbnail(record.id, thumbnail);
                db.replaceSegments(record.id, record.path, [
                    { startMs: 0, durationMs: probe.durationMs }
                ]);
            });
            ctx.summary.keyframed += 1;
        } catch (error) {
            if (isAbort(error)) throw error;
            db.transaction(() => db.failKeyframes(record.id, messageOf(error)));
            ctx.summary.failed += 1;
            ctx.emit({
                type: 'file_failed',
                path: record.path,
                stage: 'keyframes',
                message: messageOf(error)
            });
            return;
        }
    }

    ctx.emit({
        type: 'file_finished',
        path: record.path,
        durationMs: probe.durationMs,
        keyframes: frameCount
    });
}

/**
 * 这个文件该在哪几个时刻抽帧。**按类型分流**，三类素材的答案完全不同：
 *
 * - 音频没有画面，一帧都不抽（硬要抽只会得到一个 ffmpeg 报错）
 * - 图片本身就是那一帧，取 t=0；仍然要过一遍抽帧，产出的是统一尺寸的 jpg，
 *   B4 那头就不用再分类处理
 * - 视频先做场景切变检测，再按时长决定张数
 */
async function planTimes(
    record: MediaFileRecord,
    probe: NonNullable<MediaFileRecord['probe']>,
    ctx: ProcessContext,
    runOptions: { binaries: FfmpegBinaries; signal?: AbortSignal }
): Promise<number[]> {
    if (probe.kind === 'audio') return [];
    if (probe.kind === 'image') return [0];

    // 场景检测失败不该让整个文件作废——退到定间隔照样能抽出可用的帧
    let sceneTimes: number[] = [];
    try {
        sceneTimes = await detectSceneChanges(record.path, {
            threshold: ctx.keyframeOptions.sceneThreshold,
            ...runOptions
        });
    } catch (error) {
        if (isAbort(error)) throw error;
    }

    return planKeyframeTimes(probe.durationMs, sceneTimes, ctx.keyframeOptions);
}

/** 关键帧文件名的前缀。用 fileId 而不是路径，避免中文/空格/超长路径进文件名 */
function segmentKeyOf(fileId: number): string {
    return `f${String(fileId).padStart(6, '0')}`;
}
