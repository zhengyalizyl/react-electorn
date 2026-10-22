import { readFile } from 'node:fs/promises';

import type { MediaIndexDb, SearchHit } from '@magicut-react-demo/media-index';
import type { AiDecision } from '@magicut-react-demo/video-project';

import type { ModelProvider, TokenUsage } from '../llm/types';

import type { CandidateFrame, RerankIssue } from './rerank';
import { rerankCandidates } from './rerank';
import type { MatchConstraints, SceneSearchInput } from './search';
import { searchAssetSegments } from './search';

/**
 * 一个分镜的素材匹配：检索 + 精排 + 产出决策记录。
 *
 * 这是 B5 对外的唯一入口，B9 的 `AssetMatcher` 节点直接用它。
 */

export interface SceneMatchInput extends SceneSearchInput {
    /** 分镜 id。写进 `ai.decisions` 用，纯计算时可以不给 */
    sceneId?: string;
}

export interface SceneMatchResult {
    chosen: SearchHit | null;
    candidates: SearchHit[];
    /** 直接落进 `project.ai.decisions`，无需再加工 */
    decision: AiDecision;
    reranked: boolean;
    issues: RerankIssue[];
    usage: TokenUsage;
}

/**
 * 匹配一个分镜的素材。
 *
 * 流程严格照 plan.md §8：硬过滤 → BM25 → Top-K → LLM 精排 → **业务校验**。
 *
 * `decision` 是必须产出的，不是可选项（plan.md §7.1）：
 * 「为什么给分镜 03 选了这个片段」留不下痕，界面上看到不合理结果时就无从调试，
 * 用户也没法给反馈。
 */
/**
 * 一个候选带几张关键帧。
 *
 * **1 张**：每张图约 4000 输入 token（plan.md §11），候选又有好几个。
 * 一个片段是连续画面，多看几张的边际收益远不如多花的钱。
 */
const FRAMES_PER_CANDIDATE = 1;

/**
 * 最多给模型看几个候选的画面。
 *
 * 检索已经按相关度排过序，越靠后越不可能被选中；
 * 全都配图的话，一次匹配就是几万 token。
 */
const MAX_FRAMED_CANDIDATES = 6;

/**
 * 取候选的关键帧，**让模型真的看一眼画面**。
 *
 * 这一步让离线打标变成可选的：没有文字描述时，模型照样能从图里看出这是什么。
 * 关键帧文件被手动删过是常事，少一张就跳过那个候选，不让整次匹配失败。
 */
async function loadCandidateFrames(
    db: MediaIndexDb,
    candidates: readonly SearchHit[]
): Promise<CandidateFrame[]> {
    const frames: CandidateFrame[] = [];

    for (const hit of candidates.slice(0, MAX_FRAMED_CANDIDATES)) {
        const all = db.listKeyframes(hit.fileId);
        // 取落在这个片段区间里的帧；一个都没有就退回整文件的第一帧
        const inRange = all.filter(
            (frame) =>
                frame.atMs >= hit.startMs &&
                frame.atMs <= hit.startMs + hit.durationMs
        );
        const picked = (inRange.length > 0 ? inRange : all).slice(
            0,
            FRAMES_PER_CANDIDATE
        );

        for (const frame of picked) {
            try {
                frames.push({
                    segmentId: hit.segmentId,
                    base64: (await readFile(frame.path)).toString('base64'),
                    mimeType: 'image/jpeg'
                });
            } catch {
                // 帧文件没了就少给一张，不影响这次匹配
            }
        }
    }

    return frames;
}

export async function matchSceneAssets(
    db: MediaIndexDb,
    provider: ModelProvider,
    input: SceneMatchInput
): Promise<SceneMatchResult> {
    let candidates = searchAssetSegments(db, input);
    let tooShort = false;

    /**
     * **时长下限是偏好，不是"宁可没有画面"。**
     *
     * 下限来自这一镜的文案长度，而文案长度由目标时长决定。用户要 20 秒、
     * 手上只有 9 秒素材时，每一镜的下限都会高过库里**任何**一个片段——
     * 硬过滤之下一个候选都不剩，于是每一镜都被放弃，整条片子装配不出来。
     * 实跑里就是这样抛的异常。
     *
     * 短片段现在是能用的：播到素材末尾会定格在最后一帧（见 `sourceTimeMs`）。
     * 画面定住几秒不好看，但**比没有画面好得多**，而且 PlanProposal 那一步
     * 已经明确告诉过用户"差多少秒、要加素材"。
     *
     * 所以只在**一个都没有**时才放宽——有得挑的时候，下限照样把短片段挡在外面。
     */
    if (candidates.length === 0 && input.minDurationMs > 0) {
        candidates = searchAssetSegments(db, { ...input, minDurationMs: 0 });
        tooShort = candidates.length > 0;
    }

    /**
     * 还是一个都没有 → 把**还没打过标**的素材捞进来。
     *
     * 到这一步，语义检索颗粒无收。但那经常不是"库里没有合适的素材"，而是
     * **素材还没打标**：打标是单独一步、要花钱，未打标的片段 FTS 里只剩文件名，
     * 而文件名经常是 `1e00bd49-….png` 这种 UUID，任何查询词都搭不上。
     * 实跑里就是这么炸的——选了一张图片跑智能体，报「没有满足条件的素材」，
     * 而那张图明明在库里，只是从没被检索层看见过。
     *
     * 放它们进来是安全的：精排是多模态的，会把关键帧发给模型看，由模型判断
     * 这张画面配不配得上这一镜。**让模型看一眼再说不要，好过在检索层就当它不存在。**
     *
     * **已打标却没匹配上的不捞**——那说明语义层尽职了，硬塞回去只会让模型
     * 从一堆无关画面里挑一个，比诚实地说"这一镜没素材"更糟。
     */
    if (candidates.length === 0) {
        candidates = searchAssetSegments(db, {
            ...input,
            minDurationMs: 0,
            constraints: { ...(input.constraints ?? {}), includeUntagged: true }
        });
        if (candidates.length > 0 && input.minDurationMs > 0) tooShort = true;
    }

    const frames = await loadCandidateFrames(db, candidates);
    const reranked = await rerankCandidates(
        provider,
        {
            visualIntent: input.visualIntent,
            ...(input.script !== undefined ? { script: input.script } : {}),
            minDurationMs: input.minDurationMs,
            ...(input.constraints?.usedSegmentIds !== undefined
                ? { usedSegmentIds: input.constraints.usedSegmentIds }
                : {}),
            frames
        },
        candidates
    );

    const decision: AiDecision = {
        ...(input.sceneId !== undefined
            ? { sceneId: input.sceneId as AiDecision['sceneId'] }
            : {}),
        node: 'AssetMatcher',
        // 没选中时也要留一条记录：**「什么都没选」本身就是最需要解释的结果**
        chosen: reranked.chosen?.segmentId ?? '(无)',
        reason: reranked.reason,
        alternatives: reranked.alternatives.map((alt) => ({
            assetId:
                alt.segmentId as AiDecision['alternatives'][number]['assetId'],
            score: alt.score,
            rejected: alt.rejected
        }))
    };

    return {
        chosen: reranked.chosen,
        candidates,
        decision,
        reranked: reranked.reranked,
        issues: tooShort
            ? [
                  ...reranked.issues,
                  {
                      code: 'too_short' as const,
                      message:
                          `没有够长的素材，放宽时长下限后选了一个更短的——` +
                          `画面会在这一镜结束前定格在最后一帧`
                  }
              ]
            : reranked.issues,
        usage: reranked.usage
    };
}

/** repair 回边带回来的结构化失败原因（plan.md §6.1 的那个形状） */
export interface RepairFeedback {
    /** 上一轮选中但被校验否掉的片段 */
    rejectedSegmentId?: string;
    /** 校验算出来的真实需求时长。比如「这一镜要 8200ms，选中的只有 5400ms」 */
    needMs?: number;
}

/**
 * 按 repair 反馈算出下一轮的检索输入（plan.md §6.1）。
 *
 * 纯函数，返回**完整的下一轮输入**而不是零散的约束片段——时长下限住在
 * `SceneSearchInput` 上、排除列表住在 `constraints` 里，只返回后者的话
 * 调用方还得自己记得改前者，迟早漏。
 *
 * 收紧两件事：
 * 1. **排除上一轮选中的片段**——不排除的话重试会原封不动再选它一遍，
 *    这是最容易写出死循环的地方
 * 2. **抬高时长下限**——校验失败最常见的原因就是"选中的片段不够长"。
 *    只取更严的那个，repair 不该把条件放松
 */
export function applyRepairFeedback(
    previous: SceneMatchInput,
    feedback: RepairFeedback
): SceneMatchInput {
    const excluded = new Set(previous.constraints?.excludeSegmentIds ?? []);
    if (feedback.rejectedSegmentId) excluded.add(feedback.rejectedSegmentId);

    const constraints: MatchConstraints = {
        ...previous.constraints,
        // 排序只为让结果可比较、可断言，不影响检索
        excludeSegmentIds: [...excluded].sort()
    };

    return {
        ...previous,
        minDurationMs: Math.max(previous.minDurationMs, feedback.needMs ?? 0),
        constraints
    };
}
