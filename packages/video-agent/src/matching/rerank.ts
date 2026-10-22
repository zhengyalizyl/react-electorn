import type { SearchHit } from '@magicut-react-demo/media-index';

import type { AssetRerank } from '../llm/schemas';
import { assetRerankSchema } from '../llm/schemas';
import type { ModelProvider, TokenUsage } from '../llm/types';

/**
 * 候选素材精排（B5 的后半段）。
 *
 * BM25 只懂词面重合，分不出「办公室里开会」和「办公室里打扫」哪个更贴分镜。
 * 这一步把 Top-K 交给模型做语义选择——这是 plan.md §3.2 允许 LLM 做的三件事之一。
 */

/** 精排过程中发现的问题。**不抛错，交给调用方决定怎么处置** */
export interface RerankIssue {
    code:
        | 'hallucinated_id'
        | 'empty_candidates'
        | 'provider_failed'
        /** 没有够长的素材，放宽下限后选了个更短的——画面会定格在最后一帧 */
        | 'too_short';
    message: string;
}

export interface RerankResult {
    chosen: SearchHit | null;
    reason: string;
    alternatives: { segmentId: string; score: number; rejected: string }[];
    /** 精排是否真的跑了。退化到 BM25 首位时为 false */
    reranked: boolean;
    issues: RerankIssue[];
    usage: TokenUsage;
}

const ZERO_USAGE: TokenUsage = {
    promptTokens: 0,
    completionTokens: 0,
    reasoningTokens: 0,
    totalTokens: 0
};

/** 给模型看的候选清单。**只给它能看懂的东西**，路径和内部 id 之外的字段没意义 */
export function formatCandidates(
    candidates: readonly SearchHit[],
    used: ReadonlySet<string> = new Set()
): string {
    return candidates
        .map((hit, i) => {
            const size =
                hit.width && hit.height
                    ? `${hit.width}×${hit.height}`
                    : '未知尺寸';
            const audio =
                hit.hasAudio === null
                    ? ''
                    : hit.hasAudio
                      ? ' · 有音轨'
                      : ' · 无音轨';
            return [
                `${i + 1}. id=${hit.segmentId}` +
                    // 让模型知道这个片段已经被别的分镜用过了。
                    // 光在检索层降权不够——它最终还是照着语义选
                    (used.has(hit.segmentId) ? '（本片已用过）' : ''),
                `   时长 ${(hit.durationMs / 1000).toFixed(1)}s · ${size}${audio}`,
                `   画面：${hit.description ?? '(未打标)'}`,
                hit.tags.length > 0 ? `   标签：${hit.tags.join('、')}` : ''
            ]
                .filter(Boolean)
                .join('\n');
        })
        .join('\n\n');
}

export function buildRerankPrompt(
    visualIntent: string,
    script: string | undefined,
    minDurationMs: number,
    candidates: readonly SearchHit[],
    used: ReadonlySet<string> = new Set(),
    /** 随消息一起发的关键帧，顺序与这里列出的一致 */
    frames: readonly CandidateFrame[] = []
): string {
    return [
        '为下面这个分镜挑一个最合适的素材片段。',
        '',
        `画面意图：${visualIntent}`,
        script ? `配音文案：${script}` : '',
        `所需时长：不短于 ${(minDurationMs / 1000).toFixed(1)} 秒`,
        '',
        '候选（已按检索相关度排序，但相关度只看词面重合，不代表语义最贴）：',
        '',
        formatCandidates(candidates, used),
        '',
        frames.length > 0
            ? `随消息附了 ${frames.length} 张画面，按顺序对应：` +
              frames
                  .map((frame, i) => `第 ${i + 1} 张 = ${frame.segmentId}`)
                  .join('、') +
              '。**以画面为准**——文字描述可能是旧的，也可能根本没有。'
            : '',
        '**只能从上面的 id 里选一个**，不要自己编 id。',
        used.size > 0
            ? '标了「本片已用过」的素材**尽量避开**，同一个片段反复出现会很单调；实在没有更合适的再选它。'
            : '',
        '在 alternatives 里说明其余候选为什么没被选中。'
    ]
        .filter((line) => line !== '')
        .join('\n');
}

/**
 * 候选的关键帧。**让模型真的看一眼画面**，而不是只读一段文字描述。
 *
 * 离线打标那一步因此变成可选的：没有描述时，模型照样能从图里看出这是什么。
 */
export interface CandidateFrame {
    segmentId: string;
    base64: string;
    mimeType: string;
}

export interface RerankInput {
    visualIntent: string;
    script?: string;
    /** 候选的关键帧。给了就让模型看图选，不给就只能读文字 */
    frames?: readonly CandidateFrame[];
    minDurationMs: number;
    sceneLabel?: string;
    /** 本工程里已经用过的片段。只影响提示词措辞，不做硬排除 */
    usedSegmentIds?: readonly string[];
}

/**
 * 精排。
 *
 * ## 业务二次校验不能省
 *
 * `withStructuredOutput` 只保证**形状**对：`chosenAssetId` 是个 string 就合法。
 * 模型完全可能返回一个候选集里没有的 id——那在 schema 层无法察觉
 * （plan.md §4.5 里专门讲过这条）。所以这里必须再查一遍集合。
 *
 * ## 出问题时退化而不是抛错
 *
 * 幻觉 id、模型调用失败，都退化到 BM25 首位，并把问题记进 `issues`。
 * 理由是 plan.md §6.1：单个分镜出状况不该阻塞其余分镜产出。
 * 但**退化必须留痕**——静默退化的症状是"某些分镜选得莫名其妙，没人知道为什么"。
 */
export async function rerankCandidates(
    provider: ModelProvider,
    input: RerankInput,
    candidates: readonly SearchHit[]
): Promise<RerankResult> {
    if (candidates.length === 0) {
        return {
            chosen: null,
            reason: '没有满足硬过滤条件的候选素材',
            alternatives: [],
            reranked: false,
            issues: [
                {
                    code: 'empty_candidates',
                    message: '检索没有返回任何候选，请放宽约束或补充素材'
                }
            ],
            usage: ZERO_USAGE
        };
    }

    const top = candidates[0]!;
    const fallback = (issue: RerankIssue, usage: TokenUsage): RerankResult => ({
        chosen: top,
        reason: `精排未生效，退回检索首位：${issue.message}`,
        alternatives: candidates.slice(1).map((hit) => ({
            segmentId: hit.segmentId,
            score: 0,
            rejected: '未经精排'
        })),
        reranked: false,
        issues: [issue],
        usage
    });

    let result: { value: AssetRerank; usage: TokenUsage };
    try {
        result = await provider.invokeStructured<AssetRerank>({
            task: 'AssetMatcher',
            schema: assetRerankSchema,
            system: '你是视频剪辑师，为分镜挑选最贴合的素材。',
            user: buildRerankPrompt(
                input.visualIntent,
                input.script,
                input.minDurationMs,
                candidates,
                new Set(input.usedSegmentIds ?? []),
                input.frames ?? []
            ),
            ...(input.frames && input.frames.length > 0
                ? {
                      images: input.frames.map((frame) => ({
                          base64: frame.base64,
                          mimeType: frame.mimeType
                      }))
                  }
                : {})
            /**
             * **不开 thinking。**
             *
             * 实测（2026-09-28，doubao-seed-2.0-pro，同一段提示词）：
             *
             * | 配置 | 耗时 | 输出 token |
             * |---|---|---|
             * | 5 图 + 不思考 | 6.5s | 84 |
             * | 无图 + 思考 | 96s | 4846 |
             * | 1 图 + 思考 | 156s | 8734 |
             * | 5 图 + 思考 | **>180s 超时** | — |
             *
             * 「从几个候选里挑一个」会被它当成需要长篇推理的题，
             * 烧掉 8000+ token 然后撞上 120s 超时 → 退回 BM25 首位。
             * **开着 thinking 的精排等于没有精排**，比关掉严格更差。
             *
             * 慢的是思考不是图：5 张图关掉思考只要 6.5 秒。
             */
        });
    } catch (error) {
        return fallback(
            {
                code: 'provider_failed',
                message: error instanceof Error ? error.message : String(error)
            },
            ZERO_USAGE
        );
    }

    const byId = new Map(candidates.map((hit) => [hit.segmentId, hit]));
    const chosen = byId.get(result.value.chosenAssetId);

    if (!chosen) {
        // schema 放行了它，只有这里拦得住
        return fallback(
            {
                code: 'hallucinated_id',
                message: `模型选了候选集之外的 id：${result.value.chosenAssetId}`
            },
            result.usage
        );
    }

    return {
        chosen,
        reason: result.value.reason,
        // 模型也可能在 alternatives 里编 id，一并过滤——理由同上
        alternatives: result.value.alternatives
            .filter((alt) => byId.has(alt.assetId))
            .map((alt) => ({
                segmentId: alt.assetId,
                score: alt.score,
                rejected: alt.rejected
            })),
        reranked: true,
        issues: [],
        usage: result.usage
    };
}
