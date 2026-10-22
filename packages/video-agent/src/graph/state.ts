import { Annotation } from '@langchain/langgraph';
import type { AssetOverview } from '@magicut-react-demo/media-index';
import type {
    AiDecision,
    ValidationIssue,
    VideoProject
} from '@magicut-react-demo/video-project';

import type { CreativeBrief, ProductionPlan } from '../llm/schemas';

/**
 * 图的状态（plan.md §6）。
 *
 * ## 为什么不直接把 VideoProject 当状态
 *
 * 工程是**最终产物**，中途它是残缺的：分镜有了但时长还没定、素材选了但配音还没合成。
 * 硬要用 VideoProject 当中间状态，就得让 schema 允许一堆 optional，
 * 而那等于放弃了 B1 那套"非法状态构造不出来"的保证。
 *
 * 所以中间态用 `WorkingScene`，只有 `TimelineAssemble` 那一步才装配成 VideoProject。
 */

/** 一个分镜在流水线里的工作态。字段按产生顺序排列 */
export interface WorkingScene {
    /** ScenePlanner 产出 */
    goal: string;
    script: string;
    visualIntent: string;
    /** **增量失效的依据**（plan.md §6.2）：文案没变就不重新合成配音 */
    scriptHash: string;

    /** AssetMatcher 产出 */
    segmentId?: string;
    /** 选中素材的本地路径与可用时长 */
    assetPath?: string;
    assetDurationMs?: number;
    /**
     * 这一镜的画面**只能定格**：素材比分镜短，而且已经确认换不到更长的。
     *
     * 两种情况置位：
     * 1. AssetMatcher 放宽时长下限才选到东西（库里没有够长的）
     * 2. repair 重试到上限仍没通过校验，但手上有一个能用的短素材
     *
     * **不置位时不许定格**：那说明还没试过去找更长的素材，
     * 一上来就定格会把"其实有更好的选择"这件事永久掩盖掉。
     */
    assetTooShort?: boolean;
    assetWidth?: number;
    assetHeight?: number;

    /** Tts 产出。**时长是实测的**，整条时间线由它反推（§3.1） */
    audioPath?: string;
    durationMs?: number;

    /** DurationAlign 产出 */
    startMs?: number;

    /**
     * 装配进工程后拿到的 scene id。
     *
     * **必须显式存下来。** 工程里的分镜是过滤掉已放弃项后重新编号的，
     * 与 `state.scenes` 的下标**对不上**。校验失败要回流到正确的那一镜，
     * 只能靠这个映射——靠下标会在有分镜被放弃之后立刻错位，
     * 症状是 repair 永远修不好那一镜，图转到 recursionLimit。
     */
    projectSceneId?: string;

    /** 这一镜是否已被判定为无法处理，跳过但不阻塞其余（§6.1 第 4 级降级） */
    abandoned?: boolean;
    abandonReason?: string;
}

/** 校验失败回流时带的结构化原因（plan.md §6.1） */
export interface RepairRequest {
    sceneIndex: number;
    reason: string;
    /** 这一镜实际需要多长 */
    needMs?: number;
    /** 被否掉的片段 */
    rejectedSegmentId?: string;
    /**
     * 是不是**用户亲自否掉的**。
     *
     * 校验回流是机器发现"这一镜时长不对"，收紧条件后配不上时可以退回原选择
     * （重复画面是 §6.1 认可的降级）。用户否决是明确的"别用这个"——
     * 配不上就该放弃这一镜，**绝不能把它偷偷放回去**。
     *
     * 靠 `reason` 的文案去区分太脆：那句话是给人看的，改一个字就失灵。
     */
    byUser?: boolean;
}

export const AgentState = Annotation.Root({
    runId: Annotation<string>({
        reducer: (_, b) => b,
        default: () => ''
    }),
    prompt: Annotation<string>({
        reducer: (_, b) => b,
        default: () => ''
    }),
    brief: Annotation<CreativeBrief | null>({
        reducer: (_, b) => b,
        default: () => null
    }),
    /**
     * 创作过程留痕：每一步用人话说清楚它做了什么。
     *
     * **要落进工程文件**——编辑器是之后打开的，那时用户最想知道的
     * 正是"它当时怎么想的"。只在聊天页留着的话，关掉就没了。
     */
    notes: Annotation<{ node: string; text: string }[]>({
        // 追加而不是替换：每一步各留一条
        reducer: (a, b) => [...a, ...b],
        default: () => []
    }),
    /** 制作方案（PlanProposal 产出）。需求文档要照它写 */
    plan: Annotation<ProductionPlan | null>({
        reducer: (_, b) => b,
        default: () => null
    }),
    /** 成片需求文档的行。确认中断点要把它再发一遍 */
    requirements: Annotation<{ field: string; detail: string }[]>({
        reducer: (_, b) => b,
        default: () => []
    }),
    /**
     * 素材库画像（AssetScan 产出）。
     *
     * 需求文档要用它报"手上有多少素材、都是些什么"——
     * 那两句不该由模型猜，库里就查得到。
     */
    assets: Annotation<AssetOverview | null>({
        reducer: (_, b) => b,
        default: () => null
    }),
    /** 整表替换而不是追加：DurationAlign 之类的节点会重排所有分镜 */
    scenes: Annotation<WorkingScene[]>({
        reducer: (_, b) => b,
        default: () => []
    }),
    project: Annotation<VideoProject | null>({
        reducer: (_, b) => b,
        default: () => null
    }),
    issues: Annotation<ValidationIssue[]>({
        reducer: (_, b) => b,
        default: () => []
    }),
    /** 待处理的 repair 请求。空表示这一轮校验通过了 */
    repairs: Annotation<RepairRequest[]>({
        reducer: (_, b) => b,
        default: () => []
    }),
    /**
     * repair 已经试了几轮。
     *
     * **必须有上限**（plan.md §6.1）：超限走第 4 级降级（标记该分镜待人工处理），
     * 而不是无限循环。这是最容易写出死循环的地方。
     */
    repairAttempts: Annotation<number>({
        reducer: (_, b) => b,
        default: () => 0
    }),
    decisions: Annotation<AiDecision[]>({
        // 决策是追加的：每一轮 repair 的选择都要留痕（§7.1）
        reducer: (a, b) => [...a, ...b],
        default: () => []
    }),
    /**
     * 按目标时长改写文案已经试了几轮。
     *
     * **必须有上限**，理由同 repair：每轮都要重跑 TTS（按量计费），
     * 而"改写后正好落进容差"这件事不保证收敛。
     */
    durationAttempts: Annotation<number>({
        reducer: (_, b) => b,
        default: () => 0
    }),
    /** 工程落盘路径。ProjectSave 产出 */
    savedPath: Annotation<string>({
        reducer: (_, b) => b,
        default: () => ''
    })
});

export type AgentStateType = typeof AgentState.State;
export type AgentStateUpdate = typeof AgentState.Update;
