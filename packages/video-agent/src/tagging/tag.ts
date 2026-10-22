import { readFile } from 'node:fs/promises';
import path from 'node:path';

import type {
    AssetSegment,
    MediaIndexDb
} from '@magicut-react-demo/media-index';

import type { AssetTag } from '../llm/schemas';
import { assetTagSchema } from '../llm/schemas';
import type { ImageInput, ModelProvider, TokenUsage } from '../llm/types';

/**
 * 关键帧批量打标（B4）。
 *
 * ## 为什么这一层在 video-agent 而不是 media-index
 *
 * media-index 是**纯存储与外部进程**，它不该知道 LLM 的存在。打标是智能体的活，
 * 只是把索引当作读写对象。方向是 `video-agent → media-index`，反过来会让
 * 「跑个 ffprobe」也得先装 langchain。
 *
 * ## 续跑与增量靠同一个机制（同 B3）
 *
 * 没有单独的断点文件：只处理 `tag_state = 'pending'` 的片段，每个片段单独落库。
 * 中途 kill → 未提交的仍是 pending → 下次自然被捡起来。
 */

/** 关键帧图片的 MIME。B3 抽的是 JPEG */
const KEYFRAME_MIME = 'image/jpeg';

export interface TagPipelineOptions {
    db: MediaIndexDb;
    provider: ModelProvider;
    /**
     * 每个片段最多送几张关键帧。
     *
     * **这是成本旋钮**：一张 768×432 的图约 1350 输入 token（plan.md §4.2.1），
     * 3000 个片段每多送一张就是 400 万 token。默认 3 张够描述一个片段了。
     */
    maxKeyframes?: number;
    /** 并发请求数。太高会撞限流，而限流重试是纯浪费 */
    concurrency?: number;
    /** 本轮最多处理多少个片段。先小跑几个看效果时用 */
    limit?: number;
    /** 是否把上一轮失败的片段也重新排队 */
    retryFailed?: boolean;
    signal?: AbortSignal;
    onEvent?: (event: TagEvent) => void;
}

export type TagEvent =
    | { type: 'tagging_started'; total: number }
    | {
          type: 'segment_started';
          segmentId: string;
          done: number;
          total: number;
      }
    | {
          type: 'segment_tagged';
          segmentId: string;
          description: string;
          usage: TokenUsage;
      }
    | { type: 'segment_failed'; segmentId: string; message: string }
    | { type: 'segment_skipped'; segmentId: string; reason: 'no_keyframes' }
    | { type: 'tagging_finished'; summary: TagSummary };

export interface TagSummary {
    total: number;
    tagged: number;
    failed: number;
    skipped: number;
    /** 累计用量。**成本记账的唯一依据**——单价待查，但 token 数是实打实的 */
    usage: TokenUsage;
    aborted: boolean;
}

const ZERO_USAGE: TokenUsage = {
    promptTokens: 0,
    completionTokens: 0,
    reasoningTokens: 0,
    totalTokens: 0
};

function addUsage(a: TokenUsage, b: TokenUsage): TokenUsage {
    return {
        promptTokens: a.promptTokens + b.promptTokens,
        completionTokens: a.completionTokens + b.completionTokens,
        reasoningTokens: a.reasoningTokens + b.reasoningTokens,
        totalTokens: a.totalTokens + b.totalTokens
    };
}

/**
 * 从一组关键帧里均匀取若干张。
 *
 * **纯函数**，抽出来是为了能脱离文件系统与网络单测——关键帧取几张、取哪几张
 * 直接决定打标成本，这个逻辑值得单独证明。
 *
 * 取样保住首尾：开头和结尾最能代表一个片段的起止画面。
 */
export function pickKeyframes<T>(frames: readonly T[], max: number): T[] {
    if (max <= 0) return [];
    if (frames.length <= max) return [...frames];
    if (max === 1) {
        const mid = frames[Math.floor(frames.length / 2)];
        return mid === undefined ? [] : [mid];
    }
    const out: T[] = [];
    for (let i = 0; i < max; i += 1) {
        const item = frames[Math.round((i * (frames.length - 1)) / (max - 1))];
        if (item !== undefined) out.push(item);
    }
    return out;
}

/** 提示词。文件名带语义（「办公室-中景-01.mp4」），作为上下文很有用 */
export function buildTagPrompt(fileName: string, durationMs: number): string {
    return [
        '这是一个视频片段的若干关键帧，按时间先后排列。',
        `片段文件名：${fileName}`,
        `片段时长：${(durationMs / 1000).toFixed(1)} 秒`,
        '',
        '请为它打标，供后续按语义检索素材使用。',
        '只描述画面里**看得见**的内容，不要推测拍摄意图或情节。',
        '文件名仅作参考，与画面冲突时以画面为准。'
    ].join('\n');
}

async function loadImages(
    paths: readonly string[]
): Promise<{ images: ImageInput[]; missing: number }> {
    const images: ImageInput[] = [];
    let missing = 0;
    for (const file of paths) {
        try {
            images.push({
                base64: (await readFile(file)).toString('base64'),
                mimeType: KEYFRAME_MIME
            });
        } catch {
            // 关键帧文件被手动删过是常事，少一张不必让整个片段失败
            missing += 1;
        }
    }
    return { images, missing };
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
 * 跑一遍打标。
 *
 * 失败不阻塞：单个片段失败会落 `tag_state = 'failed'` 并继续下一个。
 * 3000 个片段里混进一个模型死活标不出来的，不该让整轮停下——
 * 但也不能静默吞掉，所以失败原因进库、进事件流。
 */
export async function runTaggingPipeline(
    options: TagPipelineOptions
): Promise<TagSummary> {
    const {
        db,
        provider,
        maxKeyframes = 3,
        concurrency = 2,
        limit = 100_000,
        signal,
        onEvent
    } = options;
    const emit = (event: TagEvent): void => onEvent?.(event);

    const queue: AssetSegment[] = [
        ...db.listSegmentsByTagState('pending', limit),
        ...(options.retryFailed
            ? db.listSegmentsByTagState('failed', limit)
            : [])
    ].slice(0, limit);

    const summary: TagSummary = {
        total: queue.length,
        tagged: 0,
        failed: 0,
        skipped: 0,
        usage: ZERO_USAGE,
        aborted: false
    };

    emit({ type: 'tagging_started', total: queue.length });

    let cursor = 0;
    let done = 0;

    const worker = async (): Promise<void> => {
        for (;;) {
            if (signal?.aborted) return;
            const segment = queue[cursor];
            cursor += 1;
            if (!segment) return;

            done += 1;
            emit({
                type: 'segment_started',
                segmentId: segment.id,
                done,
                total: queue.length
            });

            try {
                await tagOne(segment);
            } catch (error) {
                if (isAbort(error)) return;
                summary.failed += 1;
                const message = messageOf(error);
                db.failSegmentTags(segment.id, message);
                emit({
                    type: 'segment_failed',
                    segmentId: segment.id,
                    message
                });
            }
        }
    };

    const tagOne = async (segment: AssetSegment): Promise<void> => {
        const file = db.getFileById(segment.fileId);
        const frames = db.listKeyframes(segment.fileId);
        const chosen = pickKeyframes(frames, maxKeyframes);
        const { images } = await loadImages(chosen.map((f) => f.path));

        if (images.length === 0) {
            // 一张图都读不到就没法打标。标成 failed 而不是留 pending，
            // 否则每一轮都会重新捡起它、重新读一遍不存在的文件
            summary.skipped += 1;
            db.failSegmentTags(segment.id, '没有可用的关键帧');
            emit({
                type: 'segment_skipped',
                segmentId: segment.id,
                reason: 'no_keyframes'
            });
            return;
        }

        const result = await provider.invokeStructured<AssetTag>({
            task: 'AssetTagger',
            schema: assetTagSchema,
            system: '你是视频素材标注员，输出客观、可检索的画面描述。',
            user: buildTagPrompt(
                file ? path.basename(file.path) : '(未知)',
                segment.durationMs
            ),
            images,
            // 看图说话不需要推理。在 jsonSchema 路径上这能省掉全部 reasoning token
            thinking: 'disabled'
        });

        db.saveSegmentTags(segment.id, {
            description: result.value.description,
            tags: result.value.tags,
            subjectX: result.value.subjectCenterX,
            subjectY: result.value.subjectCenterY,
            orientation: result.value.orientation,
            hasFaces: result.value.hasFaces
        });

        summary.tagged += 1;
        summary.usage = addUsage(summary.usage, result.usage);
        emit({
            type: 'segment_tagged',
            segmentId: segment.id,
            description: result.value.description,
            usage: result.usage
        });
    };

    await Promise.all(
        Array.from(
            { length: Math.max(1, Math.min(concurrency, queue.length || 1)) },
            () => worker()
        )
    );

    summary.aborted = signal?.aborted ?? false;
    emit({ type: 'tagging_finished', summary });
    return summary;
}
