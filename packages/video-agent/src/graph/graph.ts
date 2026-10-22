import type { BaseCheckpointSaver } from '@langchain/langgraph';
import { END, START, StateGraph } from '@langchain/langgraph';

import type { GraphDeps } from './deps';
import { DEFAULT_MAX_REPAIR_ATTEMPTS } from './deps';
import {
    abandonUnfixable,
    assetMatcher,
    assetReadiness,
    collectInput,
    creativeBrief,
    decideAfterDuration,
    durationAlign,
    durationCheck,
    matchApproval,
    planProposal,
    projectSave,
    requirementApproval,
    requirementDoc,
    sceneApproval,
    scenePlanner,
    timelineAssemble,
    ttsNode,
    validationNode
} from './nodes';
import type { AgentStateType } from './state';
import { AgentState } from './state';

/**
 * 主管图（plan.md §6）。
 *
 * ```
 *  CollectInput → AssetScan(加载视频) → CreativeBrief(分析文稿)
 *      → PlanProposal(制作方案) → RequirementDoc(成片需求文档)
 *      → RequirementApproval(⏸) → ScenePlanner
 *    → ⏸SceneApproval → AssetMatcher → ⏸MatchApproval
 *    → Tts → DurationAlign → TimelineAssemble → Validation
 *         ↘ repair 回边 ↗                          ↓
 *                                              ProjectSave
 * ```
 *
 * **图里唯一的环是 `Validation → AssetMatcher`**（§3.1：时长回流会推翻已做的
 * 素材匹配）。环必须有出口，出口是 `abandonUnfixable`——重试超限就标记待人工处理，
 * 而不是继续转（§6.1）。
 */

/**
 * 校验之后往哪走——**图里最安全攸关的一个分支**。
 *
 * 抽成导出的纯函数是为了能直接单测：靠端到端场景去覆盖"重试上限"这条，
 * 需要构造一个"每轮都重新匹配成功但每轮都校验失败"的素材库，
 * 极难稳定复现。实测中把上限整个去掉，10 条端到端用例**一条都不会红**。
 */
export function decideAfterValidation(
    state: Pick<AgentStateType, 'repairs' | 'repairAttempts'>,
    maxAttempts: number
): 'ProjectSave' | 'AssetMatcher' | 'AbandonUnfixable' {
    if (state.repairs.length === 0) return 'ProjectSave';
    // 到上限就放弃这几镜，**不要继续转**——这是环的唯一出口（§6.1）
    return state.repairAttempts >= maxAttempts
        ? 'AbandonUnfixable'
        : 'AssetMatcher';
}

export interface BuildGraphOptions {
    deps: GraphDeps;
    /**
     * **必填。** 图里有两个 `interrupt`，LangGraph 在没有 checkpointer 时
     * 直接抛 `No checkpointer set`。做成可选只会让调用方在运行时才发现，
     * 所以这里用类型把它逼出来。
     *
     * 不需要持久化时传 `SqliteWasmSaver.open(':memory:')`。
     */
    checkpointer: BaseCheckpointSaver;
}

export function buildAgentGraph(options: BuildGraphOptions) {
    const { deps } = options;
    const maxAttempts = deps.maxRepairAttempts ?? DEFAULT_MAX_REPAIR_ATTEMPTS;

    const builder = new StateGraph(AgentState)
        .addNode('CollectInput', (state: AgentStateType) =>
            collectInput(deps, { runId: state.runId, prompt: state.prompt })
        )
        .addNode('AssetScan', () => assetReadiness(deps))
        .addNode('PlanProposal', (state: AgentStateType) =>
            planProposal(deps, state)
        )
        .addNode('RequirementDoc', (state: AgentStateType) =>
            requirementDoc(deps, state)
        )
        .addNode('RequirementApproval', (state: AgentStateType) =>
            requirementApproval(deps, state)
        )
        .addNode('CreativeBrief', (state: AgentStateType) =>
            creativeBrief(deps, state)
        )
        .addNode('ScenePlanner', (state: AgentStateType) =>
            scenePlanner(deps, state)
        )
        .addNode('SceneApproval', (state: AgentStateType) =>
            sceneApproval(deps, state)
        )
        .addNode('AssetMatcher', (state: AgentStateType) =>
            assetMatcher(deps, state)
        )
        .addNode('MatchApproval', (state: AgentStateType) =>
            matchApproval(deps, state)
        )
        .addNode('Tts', (state: AgentStateType) => ttsNode(deps, state))
        .addNode('DurationAlign', (state: AgentStateType) =>
            durationAlign(deps, state)
        )
        .addNode('DurationCheck', (state: AgentStateType) =>
            durationCheck(deps, state)
        )
        .addNode('TimelineAssemble', (state: AgentStateType) =>
            timelineAssemble(deps, state)
        )
        .addNode('Validation', (state: AgentStateType) =>
            validationNode(deps, state)
        )
        .addNode('AbandonUnfixable', (state: AgentStateType) =>
            abandonUnfixable(deps, state)
        )
        .addNode('ProjectSave', (state: AgentStateType) =>
            projectSave(deps, state)
        )
        .addEdge(START, 'CollectInput')
        .addEdge('CollectInput', 'AssetScan')
        .addEdge('AssetScan', 'CreativeBrief')
        // 先分析素材与文稿，再把两者拼成需求文档——文档是给人看的确认凭据，
        // 得等两份分析都拿到才有内容可写
        .addEdge('CreativeBrief', 'PlanProposal')
        .addEdge('PlanProposal', 'RequirementDoc')
        .addEdge('RequirementDoc', 'RequirementApproval')
        .addEdge('RequirementApproval', 'ScenePlanner')
        .addEdge('ScenePlanner', 'SceneApproval')
        .addEdge('SceneApproval', 'AssetMatcher')
        .addEdge('AssetMatcher', 'MatchApproval')
        // 用户在 MatchApproval 否掉素材 → 回 AssetMatcher 重挑
        .addConditionalEdges(
            'MatchApproval',
            (state: AgentStateType) =>
                state.repairs.length > 0 ? 'AssetMatcher' : 'Tts',
            { AssetMatcher: 'AssetMatcher', Tts: 'Tts' }
        )
        .addEdge('Tts', 'DurationAlign')
        .addEdge('DurationAlign', 'DurationCheck')
        // 改过文案的分镜音频作废了，回 Tts 只重合成那几镜（§6.2）
        .addConditionalEdges('DurationCheck', decideAfterDuration, {
            Tts: 'Tts',
            TimelineAssemble: 'TimelineAssemble'
        })
        .addEdge('TimelineAssemble', 'Validation')
        /**
         * 环的出口判定。三条分支，顺序不能乱：
         * 1. 校验通过 → 存盘
         * 2. 还有问题但重试没到上限 → 回 AssetMatcher（带着结构化原因）
         * 3. 到上限了 → 放弃这几镜，**不要继续转**
         */
        .addConditionalEdges(
            'Validation',
            (state: AgentStateType) =>
                decideAfterValidation(state, maxAttempts),
            {
                ProjectSave: 'ProjectSave',
                AssetMatcher: 'AssetMatcher',
                AbandonUnfixable: 'AbandonUnfixable'
            }
        )
        // 放弃之后重走一遍装配：被放弃的分镜不进时间线，剩下的仍要产出合法工程
        .addEdge('AbandonUnfixable', 'DurationAlign')
        .addEdge('ProjectSave', END);

    return builder.compile({ checkpointer: options.checkpointer });
}

export type AgentGraph = ReturnType<typeof buildAgentGraph>;
