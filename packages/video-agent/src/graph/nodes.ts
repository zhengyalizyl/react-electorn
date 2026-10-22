import { createHash } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';

import { interrupt } from '@langchain/langgraph';
import type {
    AiDecision,
    VideoProject
} from '@magicut-react-demo/video-project';
import {
    CURRENT_SCHEMA_VERSION,
    validateProject,
    videoProjectSchema
} from '@magicut-react-demo/video-project';
// 只有 io 在 Node 专用子路径上——它依赖 node:fs（plan.md §5.1）
import { saveProject } from '@magicut-react-demo/video-project/node';

import {
    creativeBriefSchema,
    productionPlanSchema,
    scenePlanSchema,
    scriptRewriteSchema
} from '../llm/schemas';
import type { SceneMatchInput } from '../matching';
import { applyRepairFeedback, matchSceneAssets } from '../matching';
import { buildMusicClipSpec, selectMusicTrack } from '../music';
import { layoutSubtitles } from '../subtitle';
import { findVoice } from '../tts';

import type { GraphDeps } from './deps';
import {
    DEFAULT_CANVAS,
    DEFAULT_DURATION_TOLERANCE,
    DEFAULT_MAX_DURATION_ATTEMPTS,
    DEFAULT_MAX_REPAIR_ATTEMPTS
} from './deps';
import type {
    AgentStateType,
    AgentStateUpdate,
    RepairRequest,
    WorkingScene
} from './state';

/**
 * 图的节点实现（plan.md §6 的 13 个节点）。
 *
 * 绝大多数节点是 B1–B8 的**薄包装**——这正是把那些能力先独立建好的收益：
 * 每一块都已单独测过、单独变异过，这里只负责串起来和处理状态流转。
 *
 * 严守 plan.md §3.2：时长计算、时间线排布、轨道对齐、JSON 校验全部是普通代码，
 * LLM 只做拆分镜、写文案、在候选里做语义选择这三件事。
 */

const pad2 = (n: number): string => String(n).padStart(2, '0');

export function hashScript(script: string): string {
    return `sha256:${createHash('sha256').update(script).digest('hex').slice(0, 32)}`;
}

/**
 * 分镜的 `scriptHash`：**（文案 + 音色）一起算**。
 *
 * 这个字段不只是 TTS 的缓存键——`TimelineAssemble` 把它当成**音频资产的内容
 * hash** 写进工程（`assets[asset_aN].hash`），而 `volcano.ts` 直接拿它命名落盘文件。
 * 音频的身份本来就取决于这两样：同一段话换个音色，是另一个文件。
 *
 * 只拿文案算的话，换音色会撞上同一个 hash、同一个文件名——做"按镜换音色"
 * 就会读到上一个音色的音频，而界面上一切正常。
 *
 * 算法与 `refine-scene.ts` 保持一致（它一直是这么算的），两条路写进同一个字段，
 * 定义不能打架。
 */
export function voiceScriptHash(script: string, voiceId: string): string {
    return `sha256:${createHash('sha256')
        .update(`${voiceId}:${script}`)
        .digest('hex')
        .slice(0, 32)}`;
}

function emit(
    deps: GraphDeps,
    event: Parameters<NonNullable<GraphDeps['onEvent']>>[0]
): void {
    deps.onEvent?.(event);
}

/**
 * 每次运行里发过什么"等你确认"。
 *
 * ## 为什么需要去重
 *
 * **LangGraph 的中断节点会被跑两遍**：第一遍跑到 `interrupt()` 挂起，
 * 用户答复后整个节点体**从头再跑一次**（`interrupt()` 这次直接返回答复）。
 * 于是 `interrupt()` 之前的代码——包括那句 `emit`——执行了两次，
 * 界面上就出现两份一模一样的分镜卡，各带一个确认按钮。
 *
 * 按内容去重而不是按节点名：repair 环会让同一个节点带着**不同的内容**再停一次，
 * 那次是真该显示的。
 *
 * 用 WeakMap 挂在 deps 上：deps 是一次运行的生命周期，运行结束自然回收。
 */
const announced = new WeakMap<GraphDeps, Set<string>>();

function emitOnce(
    deps: GraphDeps,
    key: string,
    event: Parameters<NonNullable<GraphDeps['onEvent']>>[0]
): void {
    let seen = announced.get(deps);
    if (!seen) {
        seen = new Set();
        announced.set(deps, seen);
    }
    if (seen.has(key)) return;
    seen.add(key);
    emit(deps, event);
}

/** 包一层：每个节点自动发 start/finish 事件，不用在 13 个地方各写一遍 */
function node<T>(
    deps: GraphDeps,
    name: string,
    body: () => Promise<T>
): Promise<T> {
    emit(deps, { type: 'node_start', node: name });
    return body().then((result) => {
        emit(deps, { type: 'node_finish', node: name });
        return result;
    });
}

// ── 1. CollectInput ──────────────────────────────────────────────────────

export function collectInput(
    deps: GraphDeps,
    input: { runId: string; prompt: string }
): Promise<AgentStateUpdate> {
    return node(deps, 'CollectInput', async () => {
        if (!input.prompt.trim()) {
            throw new Error('提示词为空，无从创作');
        }
        return { runId: input.runId, prompt: input.prompt };
    });
}

/**
 * 边写边播一份**给人读的创作报告**。
 *
 * ## 报告与工程数据是两回事
 *
 * 工程数据一律走 `invokeStructured`（`withStructuredOutput(...).invoke()`），
 * 要能解析、要守 schema；**流式文本绝不参与解析**——
 * 流被掐断就毁掉一整条运行，而报告少几个字无非是读着不完整。
 *
 * ## 只播可以公开的部分
 *
 * 报告讲的是"我怎么理解、打算怎么做、为什么这么选"，
 * **不含隐藏推理链**：那部分连取都不取（`streamText` 只收正文）。
 *
 * 事件节流 80ms：一次请求能吐上千块，每块发一次会把 IPC 和 React 淹掉，
 * 而人眼分不清 16ms 和 80ms。
 */
/**
 * 报告的硬约束。
 *
 * 实跑里 ScenePlanner 的报告吐了一整张 Markdown 表格（分镜序号/时长/画面内容…）——
 * 提示词只说了"两三句话"，它就超额发挥了。表格在聊天流里又长又难读，
 * 而且**那是另一步的产出**：分镜由结构化调用给，报告只该讲思路。
 */
const REPORT_RULES =
    '只写两三句话的说明，不要列表、不要表格、不要分镜清单或时间轴——' +
    '那些由后面的步骤单独产出。只讲你的理解与打算，别复述用户的原话。';

async function reportStream(
    deps: GraphDeps,
    nodeName: string,
    prompt: { system: string; user: string }
): Promise<string> {
    let text = '';
    let lastAt = 0;

    try {
        await deps.model.streamText({
            task: `${nodeName}Report`,
            system: `${prompt.system}\n${REPORT_RULES}`,
            user: prompt.user,
            onDelta: (delta) => {
                text += delta;
                const now = Date.now();
                if (now - lastAt < 80) return;
                lastAt = now;
                emit(deps, { type: 'partial', node: nodeName, text });
            }
        });
    } catch {
        // **报告失败不该毁掉创作**：它只是解说词。
        // 同 §6.1——单个可选步骤的失败不该让整条产出作废
        return '';
    }

    // 收尾补一次：最后一块可能正好落在节流窗口里
    if (text !== '') emit(deps, { type: 'partial', node: nodeName, text });
    return text;
}

/** 报告文本 → 可以写进工程的留痕。空的就不写，免得工程里躺着一堆空条目 */
function noteOf(node: string, text: string): { node: string; text: string }[] {
    return text.trim() === '' ? [] : [{ node, text: text.trim() }];
}

// ── 2/3. AssetScan：分析素材 ─────────────────────────────────────────────

/**
 * 分析素材：库里有什么，够不够用。
 *
 * **刻意不在图里重扫 3000 个文件。** 索引由 `media-index` 的命令离线建好
 * （B3/B4），图只读画像。每次创作都重扫一遍既慢又没必要，
 * 而且会把一个 IO 密集的长任务塞进一个本该几秒跑完的图里。
 *
 * 画像**不调模型**：文件数、片段数、总时长、最常出现的内容标签，库里全查得到。
 * 为这点信息再发一次多模态请求是纯浪费。
 *
 * 检查**失败要立刻报清楚**：库是空的就早说，别等跑到 AssetMatcher
 * 才以"一个候选都没有"的形式冒出来。
 */
export function assetReadiness(deps: GraphDeps): Promise<AgentStateUpdate> {
    return node(deps, 'AssetScan', async () => {
        // 画像只看**这次选中的**素材。读整库的话，用户明明只传了一个文件，
        // 准备阶段却会报"3 个文件、3 个片段"——那三个是上次索引留下的
        const assets = deps.db.assetOverview(8, deps.mediaPaths);
        const stats = {
            segments: assets.segments,
            tagged: assets.tagged
        };
        if (stats.segments === 0) {
            throw new Error(
                deps.mediaPaths === undefined
                    ? '素材库是空的。请先跑 media-index 的 index 命令建立索引。'
                    : '选中的素材里没有可用片段。请先建立索引，或换一批素材。'
            );
        }
        // **一个都没打标才警告**。部分未打标不报：打标是按量计费的动作，
        // 界面上已经没有入口，每跑一次就提醒一次"还有 N 个没打"，
        // 既帮不上忙又把真正该看的消息挤下去。
        //
        // 全都没打标是另一回事：检索退化成按文件名匹配，质量会塌，值得说一次。
        if (stats.tagged === 0) {
            emit(deps, {
                type: 'warning',
                node: 'AssetScan',
                message: `${stats.segments} 个片段都还没打标，只能按文件名检索，匹配质量会很差`
            });
        }

        const topics = assets.topTags
            .slice(0, 3)
            .map((item) => item.tag)
            .join('、');
        emit(deps, {
            type: 'decision',
            node: 'AssetScan',
            summary:
                `素材库：${assets.files} 个文件、${assets.segments} 个片段，` +
                `共 ${Math.round(assets.totalDurationMs / 1000)} 秒` +
                (topics === '' ? '' : `，以「${topics}」为主`)
        });
        return { assets };
    });
}

// ── 4b. PlanProposal：制作方案 ───────────────────────────────────────────

/**
 * 定制作方案：这条片子打算**怎么做**。
 *
 * 分析回答「这是什么」，方案回答「打算怎么做」。分开是因为同一份文稿配不同素材，
 * 做法完全不同——手上全是实拍就走混剪，只有几张图就得靠字幕和动效撑。
 * 所以这一步**必须把素材摆给模型**，否则它只能按文稿拍脑袋。
 */
export function planProposal(
    deps: GraphDeps,
    state: AgentStateType
): Promise<AgentStateUpdate> {
    return node(deps, 'PlanProposal', async () => {
        const brief = state.brief;
        if (!brief) throw new Error('还没有文稿分析结果');

        const tags = (state.assets?.topTags ?? [])
            .slice(0, 12)
            .map((item) => `${item.tag}（${item.count} 段）`)
            .join('、');

        // 报告与结构化调用**并行**：用户马上有字可看，数据照常按 schema 拿
        const report = reportStream(deps, 'PlanProposal', {
            system: '你是短视频导演，用两三句话说明你打算怎么做这条片子。',
            user:
                `主题：${brief.theme}\n受众：${brief.audience}\n` +
                (tags === '' ? '素材：没有可用的内容描述' : `素材：${tags}`)
        });

        const result = await deps.model.invokeStructured({
            task: 'PlanProposal',
            schema: productionPlanSchema,
            system:
                '你是短视频导演。根据文稿分析与手上的素材，定一个能落地的制作方案。' +
                '素材策略必须结合给出的素材内容说，没有依据就直说没有。',
            user:
                `主题：${brief.theme}\n受众：${brief.audience}\n` +
                `基调：${brief.tone}（${brief.mood}）\n` +
                `输入类型：${brief.inputKind}\n` +
                `文稿结构：${brief.scriptOutline.join('；')}\n` +
                `要点：${brief.keyPoints.join('；')}\n` +
                (brief.targetDurationSec === null
                    ? '时长：用户没要求\n'
                    : `时长：${brief.targetDurationSec} 秒\n`) +
                (tags === ''
                    ? '素材：库里还没有可用的内容描述'
                    : `素材内容：${tags}`),
            thinking: 'enabled'
        });

        const reportText = await report;

        // **在点确认之前说**：画面总量撑不住目标时长的话，成片一定会短。
        // 跑完才发现的话，用户已经等了几分钟，而且不知道是哪儿出的问题
        const gap = footageGap(
            brief.targetDurationSec,
            state.assets?.totalDurationMs ?? null
        );
        if (gap) {
            emit(deps, {
                type: 'warning',
                node: 'PlanProposal',
                message: footageGapMessage(gap)
            });
        }

        emit(deps, {
            type: 'decision',
            node: 'PlanProposal',
            summary: `制作方案：${result.value.approach}`
        });
        return {
            plan: result.value,
            notes: noteOf('PlanProposal', reportText)
        };
    });
}

/**
 * 目标时长和手上的画面对不对得上。
 *
 * ## 为什么这句话必须在准备阶段说
 *
 * 实跑：用户要 40 秒，手上只有 21 秒素材，最后出了一条 5.1 秒的片子——
 * **跑完才发现**。分镜数那边已经按素材提过醒了（见 `sceneCountTarget`
 * 与 `countConflicts`），那说的是"片子比素材长、中间黑屏"；
 * 反过来这一头它解决不了：
 * 画面总量撑不住目标时长时，成片就是会短，而用户在点确认之前完全不知道。
 *
 * 所以这里只回答一个问题：**差多少**。要不要继续是用户的事——
 * 重复用已有画面也是一种选择，替他决定才是越界。
 *
 * 两样有一样不知道就返回 null：**不猜**。
 */
export interface FootageGap {
    targetSec: number;
    footageSec: number;
    /** 差多少秒的画面 */
    shortSec: number;
}

export function footageGap(
    targetDurationSec: number | null,
    footageMs: number | null
): FootageGap | null {
    if (targetDurationSec === null || footageMs === null) return null;

    const footageSec = Math.round(footageMs / 1000);
    if (footageSec >= targetDurationSec) return null;

    return {
        targetSec: targetDurationSec,
        footageSec,
        shortSec: targetDurationSec - footageSec
    };
}

/**
 * 差多少这件事，警告和需求文档里**说同一句话**。
 *
 * 两处各写一遍的话迟早会说得不一样，而用户会以为那是两件事。
 */
export function footageGapMessage(gap: FootageGap): string {
    return (
        `目标 ${gap.targetSec} 秒，手上的画面一共 ${gap.footageSec} 秒，` +
        `差 ${gap.shortSec} 秒。超出的部分只能重复已有画面，` +
        `或者那几秒没有画面——想要完整的 ${gap.targetSec} 秒，需要再加素材。`
    );
}

// ── 4c. RequirementDoc：成片需求文档 ─────────────────────────────────────

/**
 * 把前面两步的产出**拼**成一份成片需求文档。
 *
 * ## 为什么不调模型
 *
 * 每一行的值都已经在手上了：主题/受众/基调来自文稿分析，素材规模来自库画像，
 * 音色来自配置。再发一次请求让模型"整理"一遍，只会多一次花钱的机会，
 * 外加一个**把已知事实改写错**的机会。
 *
 * 文档是给人看的确认凭据，所以**只写有据可依的字段**：
 * 稿子上那些「配色 Carbon Frost」「字体 Inter」我们根本没有，不编。
 */
export function requirementDoc(
    deps: GraphDeps,
    state: AgentStateType
): Promise<AgentStateUpdate> {
    return node(deps, 'RequirementDoc', async () => {
        const brief = state.brief;
        if (!brief) throw new Error('还没有文稿分析结果');

        const assets = state.assets;
        const plan = state.plan;
        const gap = footageGap(
            brief.targetDurationSec,
            assets?.totalDurationMs ?? null
        );
        const rows: { field: string; detail: string }[] = [
            { field: '输入类型', detail: brief.inputKind },
            {
                field: '文稿结构',
                // 从用户给的文字里读出来的段落，不是凭主题编的
                detail: brief.scriptOutline
                    .map((item, index) => `${index + 1}. ${item}`)
                    .join('　')
            },
            { field: '主题', detail: brief.theme },
            { field: '目标观众', detail: brief.audience },
            { field: '基调', detail: `${brief.tone}（情绪：${brief.mood}）` },
            { field: '题材', detail: brief.topic },
            {
                field: '内容要点',
                detail: brief.keyPoints
                    .map((point, index) => `${index + 1}. ${point}`)
                    .join('　')
            },
            {
                field: '成片时长',
                // 用户没要求就如实说"没要求"，不替他定一个数
                detail:
                    brief.targetDurationSec === null
                        ? '未指定，按文案长度自然生成'
                        : `${brief.targetDurationSec} 秒（会据此回压文案长度）`
            },
            // 撑不住目标时长时，**这句话要进用户点头的那张表**——
            // 只发一条会被后面的消息挤下去的警告是不够的
            ...(gap
                ? [{ field: '时长可行性', detail: footageGapMessage(gap) }]
                : []),
            {
                field: '口播音色',
                detail: findVoice(deps.voiceId)?.name ?? deps.voiceId
            },
            {
                field: '素材',
                detail:
                    assets === null
                        ? '未分析'
                        : `${assets.files} 个文件 / ${assets.segments} 个片段，` +
                          `共 ${Math.round(assets.totalDurationMs / 1000)} 秒` +
                          (assets.topTags.length === 0
                              ? ''
                              : `；主要内容：${assets.topTags
                                    .slice(0, 5)
                                    .map((item) => item.tag)
                                    .join('、')}`)
            },
            { field: '素材匹配度', detail: brief.materialFit },
            ...(plan
                ? [
                      { field: '制作方案', detail: plan.approach },
                      {
                          field: '成片结构',
                          detail: plan.structure
                              .map((item, index) => `${index + 1}. ${item}`)
                              .join('　')
                      },
                      { field: '节奏', detail: plan.pacing },
                      { field: '素材策略', detail: plan.materialStrategy }
                  ]
                : []),
            {
                field: '字幕与配乐',
                detail: '按分镜自动排布字幕；配乐按情绪从内置曲库选'
            }
        ];

        emit(deps, { type: 'requirements', node: 'RequirementDoc', rows });
        return { requirements: rows };
    });
}

// ── 4d. RequirementApproval：确认需求文档 ────────────────────────────────

export interface RequirementApprovalPayload {
    rows: { field: string; detail: string }[];
}

export interface RequirementApprovalAnswer {
    action: 'approve';
}

/**
 * 第三个中断点：需求文档要人点头才往下走。
 *
 * ## 为什么值得停一下
 *
 * 往后每一步都花钱、且越走越难回头：拆分镜、匹配素材、合成配音都要调模型。
 * 需求文档是**第一处能看出"它理解对了没有"的地方**——主题跑偏、时长理解错，
 * 在这里花三秒看出来，比跑完一整条再推翻便宜得多。
 *
 * 这里**只有放行一个动作**：文档是前面几步的汇总，要改得回去改提示词，
 * 在这一页改一行字并不会让模型换个思路去拆分镜——那只是自欺。
 */
export function requirementApproval(
    deps: GraphDeps,
    state: AgentStateType
): AgentStateUpdate {
    const payload: RequirementApprovalPayload = {
        rows: state.requirements
    };
    emitOnce(
        deps,
        `RequirementApproval:${hashScript(JSON.stringify(payload))}`,
        {
            type: 'awaiting_input',
            node: 'RequirementApproval',
            payload
        }
    );
    interrupt<RequirementApprovalPayload, RequirementApprovalAnswer>(payload);
    return {};
}

// ── 4. CreativeBrief ─────────────────────────────────────────────────────

export function creativeBrief(
    deps: GraphDeps,
    state: AgentStateType
): Promise<AgentStateUpdate> {
    return node(deps, 'CreativeBrief', async () => {
        // **把素材摆到模型面前**。不给的话它只能凭主题空想，
        // 说出来的"素材匹配度"就是编的；给了标签，那句话才有依据。
        const tags = (state.assets?.topTags ?? [])
            .slice(0, 12)
            .map((item) => `${item.tag}（${item.count} 段）`)
            .join('、');

        const report = reportStream(deps, 'CreativeBrief', {
            system:
                '你是短视频策划。用两三句话说明你怎么理解用户这次的输入：' +
                '他给的是需求还是文稿、讲的是什么、手上的素材撑不撑得起来。',
            user:
                `用户输入：\n${state.prompt}\n\n` +
                (tags === '' ? '素材库：没有可用的内容描述' : `素材：${tags}`)
        });

        const result = await deps.model.invokeStructured({
            task: 'CreativeBrief',
            schema: creativeBriefSchema,
            system:
                '你是短视频策划。先判断用户给的是一句需求还是一篇口播文稿，' +
                '再据此分析：文稿的结构要**从原文读出来**，不要凭主题编；' +
                '素材匹配度要结合给出的素材标签说，没有依据就说没有。',
            user:
                `用户输入：\n${state.prompt}\n\n` +
                (tags === ''
                    ? '素材库：还没有打标的素材，无法判断内容。'
                    : `素材库里的内容标签：${tags}`),
            // 提炼方向需要权衡，值得让模型想一下
            thinking: 'enabled'
        });
        const reportText = await report;
        // 分析结果**当场摊开**：主题跑偏、把一句需求当成口播稿，
        // 这些都要让人在这一步就看出来，往后每一步都基于它
        emit(deps, {
            type: 'analysis',
            node: 'CreativeBrief',
            inputKind: result.value.inputKind,
            outline: result.value.scriptOutline,
            theme: result.value.theme,
            audience: result.value.audience,
            tone: `${result.value.tone}（情绪：${result.value.mood}）`,
            keyPoints: result.value.keyPoints,
            materialFit: result.value.materialFit
        });
        return {
            brief: result.value,
            notes: noteOf('CreativeBrief', reportText)
        };
    });
}

// ── 5. ScenePlanner ──────────────────────────────────────────────────────

/** 一镜最短给 3 秒。再短就是闪，观众看不清画面也听不完一句话 */
export const MIN_SCENE_SEC = 3;

/**
 * 这条片子该拆几镜。
 *
 * ## 视频个数是**硬规则**，不是上限
 *
 * **导入多少个视频，就生成多少个分镜**——这是用户定的规矩。分镜是"换画面"：
 * 没有新画面就不该换镜，反过来，用户导进来的视频也不该有哪个被扔在一边。
 * 所以知道视频个数时它**就是**分镜数，另外两道压不下它，
 * 只退化成提示词里的参考和 `countConflicts` 里如实说出口的那几句话。
 *
 * ## 不知道视频个数时，才轮到另外两道取小
 *
 * 1. **目标时长**——10 秒的片子拆 4 镜，每镜 2.5 秒，碎得没法看。
 *    实跑里用户要「10 秒产品介绍」，模型给了 4 镜，就是这个问题。
 * 2. **可用素材总时长**——21 秒素材配出 36 秒成片，多出来的 15 秒
 *    没有画面可配，成片中间就是黑的。
 *
 * ## 为什么按视频**个数**而不是片段数
 *
 * 一个视频会被切成很多片段，按片段数算等于没算。用户说的是"导入了几个视频"，
 * 数的是**文件**。
 *
 * 三样都没有时返回 null——**不猜**，让模型自己定。
 */
export function sceneCountTarget(
    targetDurationSec: number | null,
    footageSec: number | null = null,
    videoCount: number | null = null
): number | null {
    // 一个视频一个分镜。一个视频都没有时至少给 1，
    // 让"没素材"这件事由 AssetScan 去报，而不是在这里算出个 0
    if (videoCount !== null) return Math.max(1, videoCount);

    const caps: number[] = [];
    if (targetDurationSec !== null) {
        caps.push(Math.max(1, Math.floor(targetDurationSec / MIN_SCENE_SEC)));
    }
    if (footageSec !== null) {
        caps.push(Math.max(1, Math.floor(footageSec / MIN_SCENE_SEC)));
    }
    return caps.length === 0 ? null : Math.min(...caps);
}

/**
 * 这个镜头数是怎么来的。
 *
 * 只说「该有 N 个」没用：用户不知道该多传视频、该改文案时长、还是该多给素材。
 */
export function countReason(
    targetDurationSec: number | null,
    footageSec: number | null,
    videoCount: number | null = null
): string {
    // 视频数在场时它说了算，不参与比大小
    if (videoCount !== null) {
        return `${videoCount} 个视频（导入多少个视频就生成多少个分镜）`;
    }

    const reasons: { cap: number; text: string }[] = [];
    if (targetDurationSec !== null) {
        reasons.push({
            cap: Math.max(1, Math.floor(targetDurationSec / MIN_SCENE_SEC)),
            text: `目标时长 ${targetDurationSec} 秒`
        });
    }
    if (footageSec !== null) {
        reasons.push({
            cap: Math.max(1, Math.floor(footageSec / MIN_SCENE_SEC)),
            text: `可用素材 ${footageSec} 秒`
        });
    }
    if (reasons.length === 0) return '当前限制';

    let best = reasons[0]!;
    for (const item of reasons) if (item.cap < best.cap) best = item;
    return best.text;
}

/**
 * 按视频个数定下的镜头数，和另外两道对不对得上。
 *
 * 视频数赢了之后，另外两道**不再改变结果**——但它们说的事照样会发生：
 * 5 个视频挤进 10 秒成片就是每镜 2 秒，碎；视频总时长撑不住就是会有画面不够。
 * 既然不压它，就得把话说出口，否则用户看到一条碎片子不知道是哪来的。
 *
 * 这里**只报告，不决策**：要不要少传几个视频、要不要放宽时长，是用户的事。
 */
export function countConflicts(
    sceneCount: number,
    targetDurationSec: number | null,
    footageSec: number | null
): string[] {
    const notes: string[] = [];
    if (
        targetDurationSec !== null &&
        sceneCount > Math.floor(targetDurationSec / MIN_SCENE_SEC)
    ) {
        notes.push(
            `${sceneCount} 个视频要配进 ${targetDurationSec} 秒，` +
                `平均每镜只有 ${(targetDurationSec / sceneCount).toFixed(1)} 秒——` +
                `不足 ${MIN_SCENE_SEC} 秒，画面会很碎`
        );
    }
    if (
        footageSec !== null &&
        sceneCount > Math.floor(footageSec / MIN_SCENE_SEC)
    ) {
        notes.push(
            `${sceneCount} 个视频一共只有 ${footageSec} 秒画面，` +
                `平均每个不到 ${MIN_SCENE_SEC} 秒，有的分镜会定格在最后一帧`
        );
    }
    return notes;
}

/**
 * 文案里有没有**念不出来的东西**。
 *
 * 文案会被语音合成原样念出来。序号、Markdown 记号、括号里的舞台提示，
 * 念出来全是噪音——「一点 先把工程能力补齐」「星号星号重点星号星号」。
 *
 * ## 为什么是警告而不是改写
 *
 * 悄悄替用户把文案改了，等于让界面上显示的和实际念的产生分歧，
 * 而那正是 `script_voice_mismatch` 那条不变量要防的事。
 * 更重要的是：提示词管不管用，得**有办法知道**。
 * 这个检测就是那个办法——它变红说明提示词没压住，该改的是提示词。
 */
const UNSPEAKABLE: { mark: string; pattern: RegExp }[] = [
    { mark: '序号列表', pattern: /^\s*\d+[.、)]\s/m },
    { mark: 'Markdown 记号', pattern: /(\*\*|^#{1,6}\s|^\s*[-*+]\s)/m },
    { mark: '括号注释', pattern: /[（(][^）)]{0,12}[）)]/ },
    { mark: '百分号', pattern: /%/ }
];

export function unspeakableMarks(script: string): string[] {
    return UNSPEAKABLE.filter((item) => item.pattern.test(script)).map(
        (item) => item.mark
    );
}

export function scenePlanner(
    deps: GraphDeps,
    state: AgentStateType
): Promise<AgentStateUpdate> {
    return node(deps, 'ScenePlanner', async () => {
        const brief = state.brief;
        // 素材总时长是**画面的硬边界**：成片比它长的部分没有画面可配
        const footageSec =
            state.assets === null
                ? null
                : Math.round(state.assets.totalDurationMs / 1000);
        // 一个视频一个分镜：数的是**文件**，不是切出来的片段
        const videoCount = state.assets?.files ?? null;
        const target = sceneCountTarget(
            brief?.targetDurationSec ?? null,
            footageSec,
            videoCount
        );
        /**
         * 视频数在场时，`target` 是**精确数量**而不是上限：
         * 多了要砍，少了要再要一次。没有视频数时它仍只是个上限。
         */
        const exact = videoCount !== null && target !== null;

        // 冲突在**规划之前**就说：跑完才告诉用户"每镜只有 2 秒"，
        // 他已经等了几分钟，而且不知道是哪儿出的问题
        if (exact) {
            for (const note of countConflicts(
                target,
                brief?.targetDurationSec ?? null,
                footageSec
            )) {
                emit(deps, {
                    type: 'warning',
                    node: 'ScenePlanner',
                    message: note
                });
            }
        }

        const report = reportStream(deps, 'ScenePlanner', {
            system: '你是短视频分镜策划，用两三句话说明你打算怎么拆这条片子。',
            user:
                `原始需求：${state.prompt}` +
                (target === null
                    ? ''
                    : exact
                      ? `\n恰好 ${target} 个分镜`
                      : `\n最多 ${target} 个分镜`)
        });

        /**
         * 分镜请求的正文。
         *
         * 抽出来是因为数量不够时要**原样再要一次**，只补上一句差额说明——
         * 两处各拼一遍的话，重试那一轮会悄悄少掉几条约束，
         * 而那正是它最需要约束的时候。
         */
        const buildUser = (shortfall: number | null): string =>
            [
                `原始需求：${state.prompt}`,
                brief ? `主题：${brief.theme}` : '',
                brief ? `受众：${brief.audience}` : '',
                brief ? `基调：${brief.tone}` : '',
                brief ? `要点：${brief.keyPoints.join('；')}` : '',
                // 目标时长要在**规划时**就告诉模型，而不是事后改写。
                // 一开始写得差不多，回压那一轮才有可能收敛
                brief?.targetDurationSec
                    ? `目标总时长：${brief.targetDurationSec} 秒。` +
                      `中文口播约 4.5 字/秒，请据此控制各镜文案的总字数。`
                    : '',
                // 素材摆出来：镜头数受它限制，模型得知道手上有什么
                state.assets
                    ? `可用素材：${state.assets.segments} 个片段，共 ` +
                      `${Math.round(state.assets.totalDurationMs / 1000)} 秒` +
                      (state.assets.topTags.length === 0
                          ? ''
                          : `，主要内容：${state.assets.topTags
                                .slice(0, 6)
                                .map((item) => item.tag)
                                .join('、')}`)
                    : '',
                // 画面总量是硬边界：成片比素材长的那几秒，屏幕上只会是黑的
                footageSec === null
                    ? ''
                    : `**成片总时长不要超过 ${footageSec} 秒**：手上的画面一共就这么多，` +
                      `超出的部分没有素材可配，成片中间会是空的。`,
                // 一个视频一个分镜——这条最硬，单独说，且不与"最多"同时出现：
                // 一句说"恰好 5 个"一句说"最多 3 个"，模型只会挑一句听
                exact
                    ? `**手上有 ${videoCount} 个视频，所以必须恰好拆 ${target} 个分镜**：` +
                      `一个视频一个分镜，导入多少个视频就生成多少个分镜，不多也不少。` +
                      `画面意图要让这 ${target} 个分镜各自对应不同的视频。`
                    : target === null
                      ? ''
                      : `**最多拆 ${target} 个分镜**：一镜不短于 ${MIN_SCENE_SEC} 秒，` +
                        `太碎观众看不清画面也听不完一句话。宁可少，不要多。`,
                shortfall === null
                    ? ''
                    : `上一轮你只给了 ${shortfall} 个分镜，还差 ${target! - shortfall} 个。` +
                      `请重新拆成**整整 ${target} 个**分镜——` +
                      `把内容铺开或拆细，而不是把同一段话重复一遍。`,
                '',
                '拆成若干分镜，每一镜给出目标、配音文案、画面意图。',
                '配音文案写完默念一遍：不像人在说话就重写。'
            ]
                .filter(Boolean)
                .join('\n');

        const SYSTEM =
            '你是短视频分镜策划，也是口播稿撰稿人。' +
            // 文案会被**原样念出来**，这一点必须在系统提示里就说死：
            // 只写在字段说明里的话，模型经常还是产出书面段落
            '你写的 script 会被语音合成原样念出来，所以它必须是能听懂的口播稿——' +
            '短句、说人话、不出现念不出来的符号与序号。';

        const result = await deps.model.invokeStructured({
            task: 'ScenePlanner',
            schema: scenePlanSchema,
            system: SYSTEM,
            user: buildUser(null),
            thinking: 'enabled'
        });

        const reportText = await report;
        // scriptHash 在这里就算好：后面所有增量失效判断都靠它（§6.2）
        const toWorking = (
            planned: { goal: string; script: string; visualIntent: string }[]
        ): WorkingScene[] =>
            planned.map((scene) => ({
                goal: scene.goal,
                script: scene.script,
                visualIntent: scene.visualIntent,
                scriptHash: voiceScriptHash(scene.script, deps.voiceId)
            }));

        let scenes = toWorking(result.value.scenes);

        /**
         * 少了就**再要一次**。
         *
         * 数量不够意味着用户导进来的视频里有几个根本用不上，而这正是他最直接
         * 能察觉的一件事。只重试一次：第二次还不听话多半一直不会听，
         * 而每多一轮都是一次花钱的调用。
         *
         * **不代码补齐。** 把已有文案劈成两半凑数，等于造出模型没规划过的分镜，
         * 画面意图也是假的——检索会按一句编出来的话去配素材。
         * 宁可如实说"有 N 个视频没用上"。
         */
        if (exact && scenes.length < target) {
            let retried: WorkingScene[] | null = null;
            try {
                const second = await deps.model.invokeStructured({
                    task: 'ScenePlanner',
                    schema: scenePlanSchema,
                    system: SYSTEM,
                    user: buildUser(scenes.length),
                    thinking: 'enabled'
                });
                retried = toWorking(second.value.scenes);
            } catch (error) {
                // 重试失败不该毁掉这一轮：第一轮的分镜照样是能用的分镜
                emit(deps, {
                    type: 'warning',
                    node: 'ScenePlanner',
                    message:
                        `分镜数量不够，重拆时出错，保留第一轮的结果：` +
                        `${error instanceof Error ? error.message : String(error)}`
                });
            }
            // 只在**更接近**目标时才采用：重试给得更少的话，换上去纯属更差
            if (retried && retried.length > scenes.length) scenes = retried;

            if (scenes.length < target) {
                emit(deps, {
                    type: 'warning',
                    node: 'ScenePlanner',
                    message:
                        `重拆后仍只有 ${scenes.length} 个分镜，` +
                        `${videoCount} 个视频里有 ${target - scenes.length} 个用不上`
                });
            }
        }

        // **提示词里说了数量，还是得自己兜住。** 模型不一定听话，
        // 而多出来的镜头必然配到重复画面——与其让它们混进成片，不如当场砍掉
        if (target !== null && scenes.length > target) {
            emit(deps, {
                type: 'warning',
                node: 'ScenePlanner',
                message:
                    `模型拆了 ${scenes.length} 个分镜，` +
                    // 说清楚是**哪一头**定下这个数的，否则用户改时长也没用
                    `按${countReason(
                        brief?.targetDurationSec ?? null,
                        footageSec,
                        videoCount
                    )}` +
                    (exact
                        ? `应当是 ${target} 个，`
                        : `最多 ${target} 个（一镜不短于 ${MIN_SCENE_SEC} 秒），`) +
                    `已保留前 ${target} 个`
            });
            scenes = scenes.slice(0, target);
        }

        // 念不出来的记号要说出来：提示词压没压住，得**有办法知道**
        scenes.forEach((scene, index) => {
            const marks = unspeakableMarks(scene.script);
            if (marks.length === 0) return;
            emit(deps, {
                type: 'warning',
                node: 'ScenePlanner',
                message:
                    `第 ${index + 1} 镜的文案里有念不出来的${marks.join('、')}` +
                    `——配音会把它原样念出来`
            });
        });

        emit(deps, {
            type: 'decision',
            node: 'ScenePlanner',
            summary: `拆出 ${scenes.length} 个分镜`
        });
        return { scenes, notes: noteOf('ScenePlanner', reportText) };
    });
}

// ── 6. SceneApproval（中断）──────────────────────────────────────────────

export interface SceneApprovalPayload {
    scenes: { goal: string; script: string; visualIntent: string }[];
}

/** 用户的答复。`scripts` 给了就按它覆盖文案 */
export interface SceneApprovalAnswer {
    action: 'approve' | 'modify';
    scripts?: string[];
}

/**
 * 分镜确认（中断点）。
 *
 * 用户改了文案之后**只重算 hash 变了的那几镜**（§6.2）——
 * 没有这套，人工介入就是一次等好几分钟又花一次钱，会很快被弃用。
 */
export function sceneApproval(
    deps: GraphDeps,
    state: AgentStateType
): AgentStateUpdate {
    const payload: SceneApprovalPayload = {
        scenes: state.scenes.map((s) => ({
            goal: s.goal,
            script: s.script,
            visualIntent: s.visualIntent
        }))
    };
    emitOnce(deps, `SceneApproval:${hashScript(JSON.stringify(payload))}`, {
        type: 'awaiting_input',
        node: 'SceneApproval',
        payload
    });

    const answer = interrupt<SceneApprovalPayload, SceneApprovalAnswer>(
        payload
    );
    if (answer.action === 'approve' || !answer.scripts) {
        return {};
    }

    const scenes = state.scenes.map((scene, i) => {
        const next = answer.scripts?.[i];
        if (next === undefined || next === scene.script) return scene;
        // 文案变了，这一镜的配音与时长作废；素材选择保留，
        // 由 DurationAlign 之后的校验决定还够不够长。
        // `exactOptionalPropertyTypes` 下不能显式赋 undefined，只能不带这两个键
        const { audioPath: _a, durationMs: _d, ...rest } = scene;
        void _a;
        void _d;
        return {
            ...rest,
            script: next,
            scriptHash: voiceScriptHash(next, deps.voiceId)
        };
    });
    return { scenes };
}

// ── 7. AssetMatcher ──────────────────────────────────────────────────────

/**
 * 素材匹配。
 *
 * 第一轮给所有分镜匹配；repair 回流时**只重匹配出问题的那几镜**，
 * 其余保持不动——全量重匹配会把已经确认过的选择也推翻。
 */
export function assetMatcher(
    deps: GraphDeps,
    state: AgentStateType
): Promise<AgentStateUpdate> {
    return node(deps, 'AssetMatcher', async () => {
        const repairsByIndex = new Map(
            state.repairs.map((r) => [r.sceneIndex, r])
        );
        const isRepair = repairsByIndex.size > 0;
        const scenes = [...state.scenes];
        const decisions: AiDecision[] = [];

        /**
         * 本工程里已经用过的片段，边走边攒。
         *
         * 只做降权不做排除（见 `MatchConstraints.usedSegmentIds`）。
         * 没有这个概念的时候，实跑里出现过四个分镜全选同一个片段。
         *
         * repair 轮次要把**没在重匹配的那些分镜**的选择也算进来，
         * 否则重挑时会觉得"没人用过"，又挑回同一个。
         */
        const used = new Set(
            scenes
                .filter(
                    (scene, index) =>
                        !scene.abandoned &&
                        scene.segmentId !== undefined &&
                        !repairsByIndex.has(index)
                )
                .map((scene) => scene.segmentId!)
        );

        for (const [index, scene] of scenes.entries()) {
            if (scene.abandoned) continue;
            if (isRepair && !repairsByIndex.has(index)) continue;
            if (!isRepair && scene.segmentId) continue;

            emit(deps, {
                type: 'progress',
                node: 'AssetMatcher',
                done: index + 1,
                total: scenes.length,
                label: scene.goal
            });

            const repair = repairsByIndex.get(index);
            // 配音还没合成时，用文案字数粗估一个下限；
            // 真正的时长要求由 repair 回边带回来（§6.1）
            const baseMs = scene.durationMs ?? estimateFloorMs(scene.script);

            // 收紧前的条件留一份：repair 收紧后落空时要退回它，
            // 而不是让这一镜彻底没有画面
            const baseInput: SceneMatchInput = {
                sceneId: `scene_${pad2(index + 1)}`,
                visualIntent: scene.visualIntent,
                script: scene.script,
                minDurationMs: baseMs,
                constraints: {
                    ...(deps.topK !== undefined ? { topK: deps.topK } : {}),
                    // 只在用户这次选的素材里挑。不限定的话，库里上次索引的
                    // 别的目录会被配进这条片子——用户看到自己没选过的画面
                    ...(deps.mediaPaths !== undefined
                        ? { paths: deps.mediaPaths }
                        : {}),
                    usedSegmentIds: [...used]
                }
            };
            let input = baseInput;
            if (repair) {
                input = applyRepairFeedback(baseInput, {
                    ...(repair.rejectedSegmentId !== undefined
                        ? { rejectedSegmentId: repair.rejectedSegmentId }
                        : {}),
                    ...(repair.needMs !== undefined
                        ? { needMs: repair.needMs }
                        : {})
                });
            }

            let match = await matchSceneAssets(deps.db, deps.model, input);

            /**
             * **repair 不能让结果更差。**
             *
             * 回流那一轮会排除上一轮选中的片段、并抬高时长下限。素材本来就少的
             * 时候，这两条一收紧就可能一个候选都不剩——实跑里两镜同时落空，
             * 于是整条片子装配不出来，抛异常告终。
             *
             * 而它上一轮**是配上了的**，只是时长不理想。
             * 「复用同一段素材」「画面比分镜短（定格在最后一帧）」都是 §6.1
             * 认可的降级；「整条片子没有了」不是。
             *
             * 所以收紧之后落空时，退回收紧前的条件再试一次，并说明代价。
             *
             * **用户亲自否掉的那一镜不在此列**（`byUser`）：那是明确的
             * "别用这个"，配不上就该放弃，偷偷放回去是在推翻用户的决定。
             */
            if (!match.chosen && repair && repair.byUser !== true) {
                const relaxed = await matchSceneAssets(
                    deps.db,
                    deps.model,
                    baseInput
                );
                if (relaxed.chosen) {
                    emit(deps, {
                        type: 'warning',
                        node: 'AssetMatcher',
                        message:
                            `${input.sceneId}：收紧条件后没有候选，退回上一轮的选择——` +
                            `画面可能重复或短于这一镜（会定格在最后一帧）`
                    });
                    match = relaxed;
                }
            }

            decisions.push(match.decision);

            for (const issue of match.issues) {
                emit(deps, {
                    type: 'warning',
                    node: 'AssetMatcher',
                    message: `${input.sceneId}：${issue.message}`
                });
            }

            if (!match.chosen) {
                // 第 4 级降级：标记待人工处理，**不阻塞其余分镜产出**（§6.1）
                scenes[index] = {
                    ...scene,
                    abandoned: true,
                    abandonReason: '没有满足条件的素材'
                };
                continue;
            }

            used.add(match.chosen.segmentId);
            scenes[index] = {
                ...scene,
                segmentId: match.chosen.segmentId,
                assetPath: match.chosen.path,
                assetDurationMs: match.chosen.durationMs,
                // 放宽了下限才选到 → 库里没有够长的，只能定格
                ...(match.issues.some((issue) => issue.code === 'too_short')
                    ? { assetTooShort: true }
                    : {}),
                ...(match.chosen.width !== null
                    ? { assetWidth: match.chosen.width }
                    : {}),
                ...(match.chosen.height !== null
                    ? { assetHeight: match.chosen.height }
                    : {})
            };
        }

        return { scenes, decisions, repairs: [] };
    });
}

/** 配音还没合成时的时长粗估，只用来做检索的硬下限 */
function estimateFloorMs(script: string): number {
    // 按 5 字/秒粗算，再打八折——宁可放进来多一点候选，也不要过早排除
    return Math.max(1000, Math.round((script.length / 5) * 1000 * 0.8));
}

// ── 8. MatchApproval（中断）─────────────────────────────────────────────

export interface MatchApprovalPayload {
    matches: {
        goal: string;
        segmentId: string | null;
        assetPath: string | null;
        abandoned: boolean;
    }[];
}

export interface MatchApprovalAnswer {
    action: 'approve' | 'reject';
    /** 要求换素材的分镜序号 */
    rejectedIndexes?: number[];
}

export function matchApproval(
    deps: GraphDeps,
    state: AgentStateType
): AgentStateUpdate {
    const payload: MatchApprovalPayload = {
        matches: state.scenes.map((s) => ({
            goal: s.goal,
            segmentId: s.segmentId ?? null,
            assetPath: s.assetPath ?? null,
            abandoned: s.abandoned ?? false
        }))
    };
    emitOnce(deps, `MatchApproval:${hashScript(JSON.stringify(payload))}`, {
        type: 'awaiting_input',
        node: 'MatchApproval',
        payload
    });

    const answer = interrupt<MatchApprovalPayload, MatchApprovalAnswer>(
        payload
    );
    if (answer.action === 'approve' || !answer.rejectedIndexes?.length) {
        return {};
    }

    // 用户否掉的那几镜走 repair 回边重新匹配，并把被否的片段排除掉
    const repairs: RepairRequest[] = answer.rejectedIndexes.map((index) => ({
        sceneIndex: index,
        reason: '用户否掉了这个素材',
        // 用户说了不要，配不上就放弃这一镜——不能退回去再用它
        byUser: true,
        ...(state.scenes[index]?.segmentId !== undefined
            ? { rejectedSegmentId: state.scenes[index]!.segmentId! }
            : {})
    }));
    return { repairs };
}

// ── 9. Tts ───────────────────────────────────────────────────────────────

/**
 * 配音合成。
 *
 * **增量失效的核心**（§6.2）：`scriptHash` 没变且已有音频的分镜直接跳过。
 * TTS 按量计费，人工改一段文案就重跑全部配音，会让人再也不敢点"修改"。
 */
export function ttsNode(
    deps: GraphDeps,
    state: AgentStateType
): Promise<AgentStateUpdate> {
    return node(deps, 'Tts', async () => {
        const scenes = [...state.scenes];
        let synthesized = 0;
        let cached = 0;

        for (const [index, scene] of scenes.entries()) {
            if (scene.abandoned) continue;
            if (scene.audioPath && scene.durationMs) {
                cached += 1;
                continue;
            }

            emit(deps, {
                type: 'progress',
                node: 'Tts',
                done: index + 1,
                total: scenes.length,
                label: scene.script.slice(0, 20)
            });

            const result = await deps.tts.synthesize({
                text: scene.script,
                voiceId: deps.voiceId,
                scriptHash: scene.scriptHash
            });
            scenes[index] = {
                ...scene,
                audioPath: result.path,
                durationMs: result.durationMs
            };
            synthesized += 1;
        }

        if (cached > 0) {
            emit(deps, {
                type: 'decision',
                node: 'Tts',
                summary: `新合成 ${synthesized} 段，命中缓存 ${cached} 段`
            });
        }
        return { scenes };
    });
}

// ── 10. DurationAlign ────────────────────────────────────────────────────

/**
 * 按配音真实时长反推每一镜的起点（§3.1）。
 *
 * **纯计算**。分镜首尾相接，累加得到每镜的 `startMs`——
 * 这就是不变量 3 与 4 的来源。
 */
export function durationAlign(
    deps: GraphDeps,
    state: AgentStateType
): Promise<AgentStateUpdate> {
    return node(deps, 'DurationAlign', async () => {
        let cursor = 0;
        const scenes = state.scenes.map((scene) => {
            if (scene.abandoned) return scene;
            const next = { ...scene, startMs: cursor };
            cursor += scene.durationMs ?? 0;
            return next;
        });
        return { scenes };
    });
}

// ── 10.5 DurationCheck：按目标时长回压文案 ───────────────────────────────

/** 目标时长与实际时长的偏差判定。纯函数，好单测 */
export function durationVerdict(
    actualMs: number,
    targetSec: number | null | undefined,
    tolerance: number
): 'ok' | 'too_long' | 'too_short' {
    if (!targetSec || targetSec <= 0) return 'ok';
    const targetMs = targetSec * 1000;
    const drift = (actualMs - targetMs) / targetMs;
    if (drift > tolerance) return 'too_long';
    if (drift < -tolerance) return 'too_short';
    return 'ok';
}

/**
 * 按目标时长改写文案（实跑暴露的问题）。
 *
 * 之前全流程**没有任何一处以总时长为目标**：时长由配音真实长度累加而来，
 * 而文案长度是模型自由发挥的。提示词里写「30 秒」只会被写进标题。
 *
 * ## 为什么只改文案不改分镜
 *
 * 增删分镜会把已经确认过的素材匹配全部推翻。而配音时长与文案字数直接相关，
 * 改文案就够了——改完哪几镜的 `scriptHash` 变了，§6.2 的增量失效会只重跑那几镜。
 */
export function durationCheck(
    deps: GraphDeps,
    state: AgentStateType
): Promise<AgentStateUpdate> {
    return node(deps, 'DurationCheck', async () => {
        const tolerance = deps.durationTolerance ?? DEFAULT_DURATION_TOLERANCE;
        const maxAttempts =
            deps.maxDurationAttempts ?? DEFAULT_MAX_DURATION_ATTEMPTS;
        const target = state.brief?.targetDurationSec ?? null;

        const usable = state.scenes.filter((s) => !s.abandoned);
        const actualMs = usable.reduce(
            (sum, s) => sum + (s.durationMs ?? 0),
            0
        );
        const verdict = durationVerdict(actualMs, target, tolerance);

        if (verdict === 'ok' || state.durationAttempts >= maxAttempts) {
            if (verdict !== 'ok') {
                emit(deps, {
                    type: 'warning',
                    node: 'DurationCheck',
                    message:
                        `改写 ${state.durationAttempts} 轮后仍是 ` +
                        `${(actualMs / 1000).toFixed(1)}s（目标 ${target}s），不再调整`
                });
            }
            return { durationAttempts: state.durationAttempts };
        }

        const targetMs = (target ?? 0) * 1000;
        const ratio = targetMs / actualMs;

        /**
         * 改写失败**不能毁掉整条产出**。
         *
         * 回压是优化不是必需：调不准时长，片子照样是片子；
         * 而为了调时长把已经做出来的四条轨道全扔掉，是本末倒置。
         * 实跑里这一步超时过一次，当时直接把整个运行带崩了。
         */
        let result;
        try {
            result = await deps.model.invokeStructured({
                task: 'ScriptRewrite',
                schema: scriptRewriteSchema,
                system:
                    '你是短视频文案编辑，按时长要求调整口播文案。' +
                    // 回压这一轮最容易把口播稿改回书面语：要缩短时，
                    // 模型的第一反应是把两句话并成一个长从句
                    '改完仍然要是口播稿：短句、说人话、不出现念不出来的符号与序号。' +
                    '缩短时拆句或删句，**不要把几句并成一个长句**。',
                user: [
                    `当前成片 ${(actualMs / 1000).toFixed(1)} 秒，目标 ${target} 秒。`,
                    verdict === 'too_long'
                        ? `太长了，整体需要缩到约 ${(ratio * 100).toFixed(0)}%。`
                        : `太短了，整体需要扩到约 ${(ratio * 100).toFixed(0)}%。`,
                    '',
                    '现有文案（按分镜顺序）：',
                    ...usable.map(
                        (scene, i) =>
                            `${i + 1}. ${scene.script.replace(/\n/g, ' ⏎ ')}`
                    ),
                    '',
                    '**分镜数量与顺序不要变**，只调整每一镜的文案长度。',
                    '保留原有的换行位置——换行是字幕的分段依据。',
                    '中文口播约 4.5 字/秒。'
                ].join('\n'),
                thinking: 'enabled'
            });
        } catch (error) {
            emit(deps, {
                type: 'warning',
                node: 'DurationCheck',
                message:
                    `按目标时长改写失败，保留当前文案：` +
                    `${error instanceof Error ? error.message : String(error)}`
            });
            // 不再重试——失败一次多半会一直失败，而每次都要等超时
            return { durationAttempts: maxAttempts };
        }

        // 模型没按数量给就整轮作废，别让错位的文案覆盖上去
        if (result.value.scripts.length !== usable.length) {
            emit(deps, {
                type: 'warning',
                node: 'DurationCheck',
                message:
                    `改写返回了 ${result.value.scripts.length} 段文案，` +
                    `与 ${usable.length} 个分镜对不上，本轮作废`
            });
            return { durationAttempts: maxAttempts };
        }

        let cursor = 0;
        const scenes = state.scenes.map((scene) => {
            if (scene.abandoned) return scene;
            const next = result.value.scripts[cursor++]!;
            if (next === scene.script) return scene;
            // 文案变了 → hash 变 → §6.2 只重跑这一镜的 TTS
            const { audioPath: _a, durationMs: _d, ...rest } = scene;
            void _a;
            void _d;
            return {
                ...rest,
                script: next,
                scriptHash: voiceScriptHash(next, deps.voiceId)
            };
        });

        emit(deps, {
            type: 'decision',
            node: 'DurationCheck',
            summary: `${(actualMs / 1000).toFixed(1)}s → 目标 ${target}s：${result.value.note}`
        });
        return { scenes, durationAttempts: state.durationAttempts + 1 };
    });
}

/**
 * 时长回压之后往哪走。
 *
 * 判据只有一条：**有没有分镜的音频被作废了**。改过文案的分镜会丢掉
 * `audioPath`，那就得回 Tts 重新合成；没改过就直接去装配。
 *
 * 「够不够接近目标」已经在 `durationCheck` 里判完了——这里再判一遍
 * 只会出现两处判据不一致。导出是为了能直接单测：
 * 端到端场景很难稳定造出"改写一轮后正好落进容差"的情况。
 */
export function decideAfterDuration(
    state: Pick<AgentStateType, 'scenes'>
): 'TimelineAssemble' | 'Tts' {
    return state.scenes.some(
        (scene) => !scene.abandoned && scene.audioPath === undefined
    )
        ? 'Tts'
        : 'TimelineAssemble';
}

// ── 11. TimelineAssemble ─────────────────────────────────────────────────

export function timelineAssemble(
    deps: GraphDeps,
    state: AgentStateType
): Promise<AgentStateUpdate> {
    return node(deps, 'TimelineAssemble', async () => {
        const canvas = deps.canvas ?? DEFAULT_CANVAS;
        const usable = state.scenes.filter(
            (s) => !s.abandoned && s.durationMs && s.assetPath
        );
        if (usable.length === 0) {
            // 一个分镜都没成 = 确实没有片子可出。这**不是**死循环，
            // 是如实报告"这批素材配不出这个需求"——比硬造一个空工程诚实
            const reasons = [
                ...new Set(
                    state.scenes
                        .map((s) => s.abandonReason)
                        .filter((r): r is string => Boolean(r))
                )
            ];
            throw new Error(
                `全部 ${state.scenes.length} 个分镜都没能配上素材，无法装配时间线。` +
                    (reasons.length > 0 ? `原因：${reasons.join('；')}` : '')
            );
        }

        const assets: Record<string, unknown> = {};
        const scenes: unknown[] = [];
        // 工程 scene id → state.scenes 的下标。校验回流靠它，不能靠下标推算
        const sceneIdByWorking = new Map<WorkingScene, string>();
        const videoClips: unknown[] = [];
        const voiceClips: unknown[] = [];
        const subtitleClips: unknown[] = [];

        usable.forEach((scene, index) => {
            const no = pad2(index + 1);
            const sceneId = `scene_${no}`;
            const durationMs = scene.durationMs!;
            // **起点来自 DurationAlign，这里不再自己累加。**
            // 两处各算一遍就是两个真源，迟早会在某个边界条件上对不上
            sceneIdByWorking.set(scene, sceneId);
            const cursor = scene.startMs;
            if (cursor === undefined) {
                throw new Error(
                    `分镜「${scene.goal}」没有起点，DurationAlign 没跑过？`
                );
            }

            assets[`asset_v${no}`] = {
                kind: 'video',
                path: path.relative(deps.projectDir, scene.assetPath!),
                absolutePath: scene.assetPath!,
                hash: `sha256:${scene.segmentId ?? no}`,
                durationMs: scene.assetDurationMs ?? durationMs,
                ...(scene.assetWidth !== undefined
                    ? { width: scene.assetWidth }
                    : {}),
                ...(scene.assetHeight !== undefined
                    ? { height: scene.assetHeight }
                    : {})
            };
            assets[`asset_a${no}`] = {
                kind: 'audio',
                path: path.relative(deps.projectDir, scene.audioPath!),
                absolutePath: scene.audioPath!,
                hash: scene.scriptHash,
                durationMs
            };

            // B7
            const segments = layoutSubtitles({
                script: scene.script,
                startMs: cursor,
                durationMs,
                ...(deps.subtitle ? { options: deps.subtitle } : {})
            });
            const subtitleIds = segments.map(
                (_, i) => `clip_s${no}_${pad2(i + 1)}`
            );
            segments.forEach((segment, i) => {
                subtitleClips.push({
                    kind: 'subtitle',
                    id: subtitleIds[i],
                    sceneId,
                    startMs: segment.startMs,
                    durationMs: segment.durationMs,
                    text: segment.text,
                    styleRef: 'subtitle_default'
                });
            });

            scenes.push({
                id: sceneId,
                index,
                goal: scene.goal,
                script: scene.script,
                scriptHash: scene.scriptHash,
                visualIntent: scene.visualIntent,
                startMs: cursor,
                durationMs,
                refs: {
                    // 一个分镜一个视频；配音可以多段，眼下合成的是整段一条
                    video: `clip_v${no}`,
                    voice: [`clip_a${no}`],
                    subtitle: subtitleIds
                }
            });

            /**
             * 画面能铺多久。
             *
             * 素材比这一镜短时**画面放到素材末尾就定格**，剩下的时间停在最后一帧：
             * 比"这一镜没有画面"好得多。
             *
             * **但只在明确标记过的时候这么做**（`assetTooShort`）。没标记就说明
             * 还没试过去找更长的素材——这时候照旧写满 `durationMs`，让校验去发现
             * `video_out_of_source` 并回流 repair。一上来就定格会把
             * "其实有更好的选择"这件事永久掩盖掉。
             */
            const sourceMs = scene.assetDurationMs ?? durationMs;
            const holdLastFrame =
                scene.assetTooShort === true && sourceMs < durationMs;
            const outMs = holdLastFrame ? sourceMs : durationMs;

            videoClips.push({
                kind: 'video',
                id: `clip_v${no}`,
                sceneId,
                assetId: `asset_v${no}`,
                inMs: 0,
                // 不做变速：不定格时 outMs - inMs 恰好等于 durationMs；
                // 定格时素材放完就停在最后一帧
                outMs,
                holdLastFrame,
                startMs: cursor,
                durationMs,
                crop: { anchorX: 0.5, anchorY: 0.5 },
                transform: { scale: 1, x: 0, y: 0 },
                // 相邻两镜之间给一个短交叉：素材来自不同片子，硬切会很跳。
                // 第一镜不淡入（片头淡入像加载没完），最后一镜不淡出
                transitions: {
                    in: index === 0 ? 'none' : 'fade',
                    out: index === usable.length - 1 ? 'none' : 'fade'
                },
                // **素材原声默认静音**：口播片里它会和旁白抢。
                // 实跑里第一段自带人声、第二段没有，切过去时背景音突然消失，
                // 听上去就是"两段没接好"
                muteSource: true,
                sourceGainDb: -12
            });
            voiceClips.push({
                kind: 'voice',
                id: `clip_a${no}`,
                sceneId,
                assetId: `asset_a${no}`,
                startMs: cursor,
                durationMs,
                // 刚合成出来的配音是**整段播放**，所以源内区间就是 0 .. 时长。
                // 分割之后两半才会各占一段（schema v2）
                inMs: 0,
                outMs: durationMs,
                // **送进 TTS 的就是这串字**，和分镜的 script 一模一样。
                // 落盘之后 validate 才能把"显示的 == 合成的"钉成不变量；
                // 这里若做任何加工（去标点、改写），那条校验立刻会红
                text: scene.script,
                gainDb: 0,
                provider: {
                    name: deps.tts.name,
                    model: deps.tts.model,
                    voiceId: deps.voiceId
                }
            });
        });

        const last = usable[usable.length - 1]!;
        const totalMs = last.startMs! + last.durationMs!;

        // B8
        const selection = selectMusicTrack({
            ...(state.brief?.mood !== undefined
                ? { mood: state.brief.mood }
                : {}),
            ...(state.brief?.topic !== undefined
                ? { topic: state.brief.topic }
                : {}),
            totalMs,
            ...(deps.musicLibrary ? { library: deps.musicLibrary } : {})
        });
        const musicClip = buildMusicClipSpec(selection.track, totalMs);
        assets['asset_m01'] = {
            kind: 'music',
            path: selection.track.path,
            absolutePath: null,
            hash: `sha256:${selection.track.id}`,
            durationMs: selection.track.durationMs
        };

        const now = new Date().toISOString();
        const project = videoProjectSchema.parse({
            schemaVersion: CURRENT_SCHEMA_VERSION,
            project: {
                id: `prj_${state.runId}`,
                title: state.brief?.theme ?? '未命名工程',
                sourcePrompt: state.prompt,
                createdAt: now,
                updatedAt: now
            },
            canvas: {
                ...canvas,
                durationMs: totalMs,
                safeArea: { bottom: 120 }
            },
            assets,
            scenes,
            tracks: [
                { id: 'track_video', kind: 'video', clips: videoClips },
                { id: 'track_voice', kind: 'voice', clips: voiceClips },
                {
                    id: 'track_subtitle',
                    kind: 'subtitle',
                    clips: subtitleClips
                },
                {
                    id: 'track_music',
                    kind: 'music',
                    clips: [
                        {
                            kind: 'music',
                            id: 'clip_m01',
                            assetId: 'asset_m01',
                            startMs: musicClip.startMs,
                            durationMs: musicClip.durationMs,
                            gainDb: musicClip.gainDb,
                            fade: musicClip.fade,
                            ducking: musicClip.ducking
                        }
                    ]
                }
            ],
            styles: {
                subtitle_default: {
                    fontFamily: 'Noto Sans SC',
                    fontSize: 42,
                    fontWeight: 700,
                    color: '#FFFFFF',
                    stroke: { color: '#000000', width: 4 },
                    align: 'center'
                }
            },
            render: {
                container: 'mp4',
                videoCodec: 'h264',
                audioCodec: 'aac',
                bitrateKbps: 8000,
                preset: 'medium'
            },
            ai: {
                runId: state.runId,
                graphVersion: '1.0.0',
                approvals: [],
                decisions: state.decisions,
                // 创作过程留痕跟着工程走：编辑器是之后打开的
                notes: state.notes,
                // **序号要用原始下标**。先 filter 再用回调里的 i，
                // 拿到的是"放弃列表里的第几个"——第 3 镜被放弃会被记成 scene_01，
                // 而 scene_01 在成片里是另一镜，看的人只会更糊涂
                failures: state.scenes
                    .map((scene, index) => ({ scene, index }))
                    .filter((item) => item.scene.abandoned)
                    .map((item) => ({
                        node: 'AssetMatcher',
                        reason: item.scene.abandonReason ?? '未知',
                        attempts: state.repairAttempts,
                        resolution: '已跳过该分镜，待人工处理',
                        // 规划时的序号。这一镜没进成片，所以不能用成片里的 id
                        sceneId: `规划第 ${item.index + 1} 镜`
                    }))
            }
        }) as VideoProject;

        const tagged = state.scenes.map((scene) => {
            const id = sceneIdByWorking.get(scene);
            return id === undefined ? scene : { ...scene, projectSceneId: id };
        });
        return { project, scenes: tagged };
    });
}

// ── 12. Validation ───────────────────────────────────────────────────────

/**
 * 校验并把失败翻译成 repair 请求（§6.1）。
 *
 * **不让 LLM 自由重试**：带结构化的失败原因回到 AssetMatcher，
 * 下一轮检索直接带上 `minDurationMs` 的硬过滤。
 */
export function validationNode(
    deps: GraphDeps,
    state: AgentStateType
): Promise<AgentStateUpdate> {
    return node(deps, 'Validation', async () => {
        const project = state.project;
        if (!project) return { issues: [], repairs: [] };

        const issues = validateProject(project);
        if (issues.length === 0) return { issues: [], repairs: [] };

        const repairs: RepairRequest[] = [];
        for (const issue of issues) {
            if (issue.sceneId === undefined) continue;
            // **按 projectSceneId 反查原始下标**，不要用工程里的 index：
            // 工程里的分镜是过滤掉已放弃项后重新编号的，两边对不上
            const index = state.scenes.findIndex(
                (scene) => scene.projectSceneId === (issue.sceneId as string)
            );
            if (index < 0) continue;
            repairs.push({
                sceneIndex: index,
                reason: issue.code,
                ...(issue.expectedMs !== undefined
                    ? { needMs: issue.expectedMs }
                    : {}),
                ...(state.scenes[index]?.segmentId !== undefined
                    ? { rejectedSegmentId: state.scenes[index]!.segmentId! }
                    : {})
            });
        }

        emit(deps, {
            type: 'warning',
            node: 'Validation',
            message: `${issues.length} 条校验问题，${repairs.length} 条可回流重试`
        });
        return { issues, repairs, repairAttempts: state.repairAttempts + 1 };
    });
}

/**
 * repair 超限时的第 4 级降级（§6.1）。
 *
 * **手上有素材的改成定格，一个都没配上的才真的放弃**，
 * 两种都不阻塞其余分镜产出。没有这一步，「素材全都太短」的库
 * 会让图无限循环。
 */
export function abandonUnfixable(
    deps: GraphDeps,
    state: AgentStateType
): AgentStateUpdate {
    const failing = new Set(state.repairs.map((r) => r.sceneIndex));

    /**
     * 重试到上限之后怎么办。
     *
     * **手上有素材就定格，别整镜扔掉。** 走到这里说明"换一个更长的"已经
     * 试过 N 轮、确实换不到——那正是定格该出场的时候（画面放完停在最后一帧）。
     * 整镜放弃的话，素材普遍偏短时每一镜都会被弃，最后整条片子装配不出来，
     * 用户拿到的是一个异常堆栈。实跑里就是这么炸的。
     *
     * 一个素材都没配上的才真的放弃——那时确实没有画面可用。
     */
    let held = 0;
    let dropped = 0;
    const scenes = state.scenes.map((scene, index) => {
        if (!failing.has(index)) return scene;
        if (scene.assetPath !== undefined) {
            held += 1;
            return { ...scene, assetTooShort: true };
        }
        dropped += 1;
        return {
            ...scene,
            abandoned: true,
            abandonReason: `repair 重试 ${state.repairAttempts} 轮仍未通过校验`
        };
    });

    if (held > 0) {
        emit(deps, {
            type: 'warning',
            node: 'Repair',
            message:
                `${held} 个分镜换不到更长的素材，画面将在这一镜结束前` +
                `定格在最后一帧`
        });
    }
    if (dropped > 0) {
        emit(deps, {
            type: 'warning',
            node: 'Repair',
            message: `${dropped} 个分镜重试到上限且没有可用素材，标记为待人工处理`
        });
    }
    return { scenes, repairs: [] };
}

// ── 13. ProjectSave ──────────────────────────────────────────────────────

export async function projectSave(
    deps: GraphDeps,
    state: AgentStateType
): Promise<AgentStateUpdate> {
    const update = await node(deps, 'ProjectSave', async () => {
        const project = state.project;
        if (!project) throw new Error('没有可保存的工程');

        // 原子写要把临时文件放在**同一个目录**里（rename 只在同一文件系统内原子），
        // 所以目录必须先存在——B1 的 saveProject 不负责建目录
        await mkdir(deps.projectDir, { recursive: true });
        const file = path.join(deps.projectDir, 'project.json');
        // B1 的原子写：临时文件 + fsync + rename
        await saveProject(file, project);
        return { savedPath: file };
    });

    // `finished` 是**运行级**事件，不属于任何节点，所以发在 node_finish 之后。
    // 发在节点体内的话，事件流的最后一条会是 node_finish，
    // UI 那边"跑完了没有"就得靠猜
    emit(deps, { type: 'finished', savedPath: update.savedPath });
    return update;
}

export const MAX_REPAIR_ATTEMPTS = DEFAULT_MAX_REPAIR_ATTEMPTS;
