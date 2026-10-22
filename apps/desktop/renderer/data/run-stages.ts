import type { RunPhase } from '@/renderer/data/use-agent-run';

/**
 * 创作过程的四个阶段。
 *
 * ## 为什么要在节点之上再盖一层
 *
 * 图里有 14 个节点（`CollectInput`、`DurationCheck`、`AbandonUnfixable`…），
 * 逐个报给用户只会让他数不清还剩多少。四个阶段是**用户视角的分法**：
 * 先准备、再有分镜、再有声音、最后成片。
 *
 * ## 状态一律从智能体的真实进度推出来
 *
 * 不做任何"看着像在跑"的动画：某个阶段亮着，是因为图**确实**停在它辖下的某个节点。
 * 节点名不认识时保持上一个阶段，而不是猜一个——猜错了就是在骗用户。
 */

export type StageId = 'prepare' | 'storyboard' | 'voice' | 'video';

export type StageStatus =
    /** 还没轮到 */
    | 'pending'
    /** 正在跑 */
    | 'running'
    /** 停在中断点，等用户确认 */
    | 'waiting'
    | 'done'
    | 'failed';

export interface StageView {
    id: StageId;
    /** 「01」「02」…设计稿里编号是标题的一部分 */
    ordinal: string;
    label: string;
    /** 这一阶段在做什么。文案逐字取自设计稿 */
    desc: string;
    status: StageStatus;
}

export const STAGE_LABELS: Record<StageId, string> = {
    prepare: '准备阶段',
    storyboard: '创建分镜',
    voice: '配音生成',
    video: '视频生成'
};

/** 逐字取自设计稿 frame OrZJP 的 Step Desc */
export const STAGE_DESCRIPTIONS: Record<StageId, string> = {
    prepare: '加载视频、分析文稿、定方案',
    storyboard: '生成分镜并等待确认',
    voice: '合成口播并匹配素材',
    video: '输出预览并进入编辑'
};

/**
 * 状态的中文说法。
 *
 * 设计稿里「未开始」写的是「待确认」（对话流）与「待执行」（执行目录）。
 * 这里两处统一用**待执行**：我们多了一种真实存在的「等你确认」状态
 * （图停在中断点），和「待确认」一字之差却意思相反，并排放会看错。
 */
export const STATUS_TEXT: Record<StageStatus, string> = {
    pending: '待执行',
    running: '进行中',
    waiting: '等你确认',
    done: '已完成',
    failed: '失败'
};

const ORDER: readonly StageId[] = ['prepare', 'storyboard', 'voice', 'video'];

/**
 * 节点 → 阶段。
 *
 * 素材匹配（`AssetMatcher` / `MatchApproval`）归在「创建分镜」下：
 * 分镜要配上素材才算立得住，而且那个中断点确认的正是"这镜用哪段素材"。
 *
 * 字幕与配乐没有独立节点，它们在 `TimelineAssemble` 里一并做掉。
 */
const NODE_STAGE: Record<string, StageId> = {
    CollectInput: 'prepare',
    AssetScan: 'prepare',
    CreativeBrief: 'prepare',
    PlanProposal: 'prepare',
    RequirementDoc: 'prepare',
    RequirementApproval: 'prepare',
    ScenePlanner: 'storyboard',
    SceneApproval: 'storyboard',
    AssetMatcher: 'storyboard',
    MatchApproval: 'storyboard',
    AbandonUnfixable: 'storyboard',
    Tts: 'voice',
    DurationAlign: 'voice',
    DurationCheck: 'voice',
    TimelineAssemble: 'video',
    Validation: 'video',
    ProjectSave: 'video'
};

/** 节点属于哪个阶段。不认识的节点返回 null——**宁可不显示也不猜** */
export function stageOfNode(node: string | null): StageId | null {
    if (node === null) return null;
    return NODE_STAGE[node] ?? null;
}

export interface RunProgress {
    phase: RunPhase;
    node: string | null;
}

/**
 * 当前该点亮哪个阶段。
 *
 * 图里有回环（`DurationCheck` 不满意会退回 `Tts`），所以这里**不记最远到过哪**，
 * 只看当前节点——退回配音时就该显示在配音，显示成"已完成"是撒谎。
 */
export function stagesOf(run: RunProgress): StageView[] {
    // 停在中断点时**不看节点名**：两个中断点都归在「创建分镜」下，
    // 而 `awaiting_*` 事件本身就已经说明了停在哪。
    // 只认 node 的话，节点事件还没到就会错标成"准备阶段进行中"
    const current =
        run.phase === 'awaiting_requirements'
            ? 'prepare'
            : run.phase === 'awaiting_scenes' ||
                run.phase === 'awaiting_matches'
              ? 'storyboard'
              : stageOfNode(run.node);
    const currentIndex = current === null ? -1 : ORDER.indexOf(current);

    return ORDER.map((id, index) => ({
        id,
        ordinal: String(index + 1).padStart(2, '0'),
        label: STAGE_LABELS[id],
        desc: STAGE_DESCRIPTIONS[id],
        status: statusOf(run, index, currentIndex)
    }));
}

function statusOf(
    run: RunProgress,
    index: number,
    currentIndex: number
): StageStatus {
    // 跑完了就是四个阶段全done，不管最后停在哪个节点
    if (run.phase === 'finished') return 'done';
    // 还没开跑（含没有桥的情况）：全是灰的，不要伪装成"准备中"
    if (run.phase === 'idle' || run.phase === 'unavailable') return 'pending';

    // 连第一个节点事件都还没到：刚发起，算在准备阶段
    if (currentIndex === -1) {
        return index === 0
            ? run.phase === 'failed'
                ? 'failed'
                : 'running'
            : 'pending';
    }

    if (index < currentIndex) return 'done';
    if (index > currentIndex) return 'pending';

    if (run.phase === 'failed') return 'failed';
    // 停在中断点等人：和"正在跑"要分开说，否则用户会一直等一个不会自己动的进度
    if (
        run.phase === 'awaiting_requirements' ||
        run.phase === 'awaiting_scenes' ||
        run.phase === 'awaiting_matches'
    ) {
        return 'waiting';
    }
    return 'running';
}
