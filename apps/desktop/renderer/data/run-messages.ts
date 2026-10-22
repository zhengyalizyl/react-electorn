import type {
    AgentRunEvent,
    MatchPreview,
    ScenePreview
} from '@/client/agent-ipc';
import { isKnownNode, labelOfNode } from '@/renderer/data/node-labels';

/**
 * 把一次创作**摊成一条聊天记录**（设计稿 frame W8bPLG）。
 *
 * ## 为什么要单独一层，而不是直接用 `AgentRunState`
 *
 * 运行状态是**当前快照**：`scenes` 会被第二次中断覆盖，`matches` 同理。
 * 聊天记录要的是**历史**——你确认过的那版分镜，滚回去还得看得见。
 * 两者形状根本不同，硬用一个会逼着组件到处 if。
 *
 * ## 每个内容块前面有一句开场白
 *
 * 设计稿是这么排的：一句话说明这一步做了什么，紧跟着才是那块内容
 * （摘要卡、表格），需要确认的话再跟一个确认动作。光甩一张表出来，
 * 用户得自己猜"这是什么、要我干嘛"。
 *
 * 开场白是**对系统真实动作的陈述**，不是编出来的结论：
 * 说"拆出了 6 个分镜"时，6 就是图真给的数。
 *
 * ## 三条规矩
 *
 * 1. **只追加，不重排。** 每条消息带一个稳定 key（事件序号），
 *    React 不会因为新消息到达而重挂已有的那些——输入框的焦点、展开状态都保得住。
 * 2. **不编造对话。** 助手说的每句话都来自图真的报上来的事件（decision / warning），
 *    没有"让我想想…"这种凑气氛的句子。
 * 3. **确认留痕。** 用户点了「就这样，继续」，记录里就多一条右侧气泡，
 *    而不是让那条中断消息悄悄消失。
 */

export type RunMessage =
    /** 开场：你提交的文稿与配置 */
    | {
          key: string;
          role: 'user';
          kind: 'request';
          script: string;
          voiceId: string | null;
      }
    /**
     * 模型**正在写**的那段。一个节点只有一条，原地增长。
     *
     * 节点写完之后它不会消失——那段文字正是这一步的产出摘要，
     * 留着才看得出"它当时写了什么"。
     */
    | {
          key: string;
          role: 'assistant';
          kind: 'streaming';
          node: string;
          text: string;
          /** 还在写吗。写完了就不再闪光标 */
          live: boolean;
      }
    /** 助手的一句话。`tone` 区分正常结论与警告 */
    | {
          key: string;
          role: 'assistant';
          kind: 'text';
          text: string;
          tone: 'normal' | 'warning';
      }
    /**
     * 四个阶段的执行要点。**整条记录里只有一条**，随进度原地更新——
     * 每个节点都追加一条的话，记录会被几十条"正在 XX"淹掉。
     */
    | { key: string; role: 'assistant'; kind: 'stages' }
    /** 分镜列表，等你确认 */
    | {
          key: string;
          role: 'assistant';
          kind: 'scenes';
          scenes: ScenePreview[];
          /** 还在等确认吗。确认过的历史消息只读 */
          pending: boolean;
      }
    /** 素材匹配表，等你确认 */
    | {
          key: string;
          role: 'assistant';
          kind: 'matches';
          matches: MatchPreview[];
          pending: boolean;
      }
    /** 文稿分析结果。准备阶段摊开给用户看 */
    | {
          key: string;
          role: 'assistant';
          kind: 'analysis';
          inputKind: string;
          outline: string[];
          theme: string;
          audience: string;
          tone: string;
          keyPoints: string[];
          materialFit: string;
      }
    /** 成片需求文档：字段 + 说明。`pending` 时底下挂确认按钮 */
    | {
          key: string;
          role: 'assistant';
          kind: 'requirements';
          rows: { field: string; detail: string }[];
          pending: boolean;
      }
    /** 跑完了的概览 */
    | { key: string; role: 'assistant'; kind: 'overview'; savedPath: string }
    | { key: string; role: 'assistant'; kind: 'error'; message: string }
    /** 右侧的确认气泡 */
    | { key: string; role: 'user'; kind: 'reply'; text: string };

export interface RequestInput {
    script: string;
    voiceId?: string | undefined;
}

/**
 * 记录的头两条：你的需求，和四个阶段的执行要点。
 *
 * 执行要点**一开始就在**，不等第一个节点事件——它是这一页的骨架，
 * 晚一秒插进来会让记录在眼前跳一下；而且"还没开始"本身就是四个阶段的合法状态。
 */
export function initialMessages(input: RequestInput): RunMessage[] {
    return [
        {
            key: 'request',
            role: 'user',
            kind: 'request',
            script: input.script,
            voiceId: input.voiceId ?? null
        },
        {
            key: 'intro',
            role: 'assistant',
            kind: 'text',
            // 逐字取自设计稿的「智能体开场说明」。这句描述的是我们真实的流程：
            // 拆分镜 → 匹配素材 → 合成配音 → 进编辑器，所以照抄不算编造
            text: '我已收到创作需求。接下来会按即时协作流程推进：先拆解目标受众与叙事节奏，再生成分镜规划、匹配素材、选择口播音色，最后进入编辑器等待你确认细节。',
            tone: 'normal'
        },
        { key: 'stages', role: 'assistant', kind: 'stages' }
    ];
}

/**
 * 把还在等确认的消息标记成已处理。
 *
 * 用户答复之后，那条消息就变成历史了：控件收起来，但内容留着。
 */
function settle(messages: readonly RunMessage[]): RunMessage[] {
    return messages.map((message) =>
        message.kind === 'streaming' && message.live
            ? { ...message, live: false }
            : (message.kind === 'scenes' ||
                    message.kind === 'matches' ||
                    message.kind === 'requirements') &&
                message.pending
              ? { ...message, pending: false }
              : message
    );
}

/**
 * 一个事件进来，记录怎么长。
 *
 * `seq` 是全局递增的事件序号，用来做 key——节点会重复出现（图里有回环），
 * 用节点名做 key 会撞车。
 */
export function messagesAfterEvent(
    prev: readonly RunMessage[],
    event: AgentRunEvent,
    seq: number
): RunMessage[] {
    switch (event.type) {
        case 'partial': {
            // 一个节点只有一条流式消息，**原地更新**而不是每块追加一条
            const existing = prev.find(
                (message) =>
                    message.kind === 'streaming' && message.node === event.node
            );
            if (existing) {
                return prev.map((message) =>
                    message === existing
                        ? { ...existing, text: event.text, live: true }
                        : message
                );
            }
            return [
                ...prev,
                {
                    key: `p${seq}`,
                    role: 'assistant',
                    kind: 'streaming',
                    node: event.node,
                    text: event.text,
                    live: true
                }
            ];
        }

        case 'node_finish':
            // 这个节点写完了：光标停掉，文字留着
            return prev.map((message) =>
                message.kind === 'streaming' && message.node === event.node
                    ? { ...message, live: false }
                    : message
            );

        case 'decision':
            return [
                ...prev,
                {
                    key: `d${seq}`,
                    role: 'assistant',
                    kind: 'text',
                    text: event.summary,
                    tone: 'normal'
                }
            ];

        case 'warning':
            return [
                ...prev,
                {
                    key: `w${seq}`,
                    role: 'assistant',
                    kind: 'text',
                    // 带上节点的人话名：光一句"时长没调准"看不出是哪一步出的事。
                    // 但**不认识的节点名不往外甩**——「AssetUnderstand：…」这种
                    // 内部叫法对用户只是噪声，宁可不带前缀
                    text: isKnownNode(event.node)
                        ? `${labelOfNode(event.node)}：${event.message}`
                        : event.message,
                    tone: 'warning'
                }
            ];

        case 'analysis':
            return [
                ...prev,
                {
                    key: `ai${seq}`,
                    role: 'assistant',
                    kind: 'text',
                    text: `我把你的输入读了一遍，识别为${event.inputKind}。分析如下：`,
                    tone: 'normal'
                },
                {
                    key: `a${seq}`,
                    role: 'assistant',
                    kind: 'analysis',
                    inputKind: event.inputKind,
                    outline: event.outline,
                    theme: event.theme,
                    audience: event.audience,
                    tone: event.tone,
                    keyPoints: event.keyPoints,
                    materialFit: event.materialFit
                }
            ];

        case 'requirements':
            return [
                ...prev,
                {
                    key: `q${seq}i`,
                    role: 'assistant',
                    kind: 'text',
                    text: '素材和文稿都分析完了，这是我整理的成片需求文档：',
                    tone: 'normal'
                },
                {
                    key: `q${seq}`,
                    role: 'assistant',
                    kind: 'requirements',
                    rows: event.rows,
                    // 文档先只读挂出来；`awaiting_requirements` 到了才变成待确认。
                    // 两条事件之间有间隙，这段时间按钮不该出现——图还没停下
                    pending: false
                }
            ];

        case 'awaiting_requirements':
            // 图停在确认点了。把刚才那张表标成待确认，而不是再发一张一样的
            return prev.map((message) =>
                message.kind === 'requirements'
                    ? { ...message, pending: true }
                    : message
            );

        case 'awaiting_scenes':
            return [
                ...prev,
                {
                    key: `si${seq}`,
                    role: 'assistant',
                    kind: 'text',
                    text: `文稿已经拆成 ${event.scenes.length} 个分镜，每段带文案与画面意图。你看一下要不要改文案——改完我再往下走。`,
                    tone: 'normal'
                },
                {
                    key: `s${seq}`,
                    role: 'assistant',
                    kind: 'scenes',
                    scenes: event.scenes,
                    pending: true
                }
            ];

        case 'awaiting_matches': {
            const abandoned = event.matches.filter(
                (match) => match.abandoned
            ).length;
            return [
                ...prev,
                {
                    key: `mi${seq}`,
                    role: 'assistant',
                    kind: 'text',
                    // 配不上的那几镜要在开场白里就说明白，别让用户自己数表格
                    text:
                        `素材匹配完成，${event.matches.length - abandoned}/${event.matches.length} 个分镜配上了片段` +
                        (abandoned > 0
                            ? `，${abandoned} 个没配上、会被跳过。`
                            : '。') +
                        '不满意的标出来，我重挑。',
                    tone: 'normal'
                },
                {
                    key: `m${seq}`,
                    role: 'assistant',
                    kind: 'matches',
                    matches: event.matches,
                    pending: true
                }
            ];
        }

        case 'finished':
            // 跑完了，任何还挂着的确认都已经不作数了
            return [
                ...settle(prev),
                {
                    key: `f${seq}`,
                    role: 'assistant',
                    kind: 'overview',
                    savedPath: event.savedPath
                }
            ];

        case 'error':
            return [
                ...settle(prev),
                {
                    key: `e${seq}`,
                    role: 'assistant',
                    kind: 'error',
                    message: event.message
                }
            ];

        default:
            // node_start / progress / cancelled 不进记录：
            // 它们是过程噪声，进度由执行要点那条与「正在…」那行表达
            return [...prev];
    }
}

/**
 * 用户答复了中断点。
 *
 * 追加一条右侧气泡，并把等待中的那条消息收成历史——
 * **两件事必须一起做**，否则会出现"已经确认过了，确认按钮还在"。
 */
export function messagesAfterReply(
    prev: readonly RunMessage[],
    text: string,
    seq: number
): RunMessage[] {
    return [
        ...settle(prev),
        { key: `r${seq}`, role: 'user', kind: 'reply', text }
    ];
}
