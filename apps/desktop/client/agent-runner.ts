import { randomUUID } from 'node:crypto';
import path from 'node:path';

import { Command } from '@langchain/langgraph';
import { MediaIndexDb } from '@magicut-react-demo/media-index';
import type {
    GraphDeps,
    GraphEvent,
    ModelProvider
} from '@magicut-react-demo/video-agent';
import {
    ArkChatModelProvider,
    buildAgentGraph,
    DEFAULT_VOICE_ID,
    FailoverModelProvider,
    isUsableVoiceId,
    loadFallbackLlmConfig,
    loadLlmConfig,
    makeVoiceProvider,
    MockModelProvider,
    SqliteWasmSaver,
    type TtsCacheStore
} from '@magicut-react-demo/video-agent';

import type {
    AgentRunEvent,
    ApprovalAnswer,
    MatchPreview,
    RunSnapshot,
    RunStatus,
    ScenePreview
} from './agent-ipc';

/**
 * 主进程里的智能体运行器（B10）。
 *
 * ## 两条不能破的线
 *
 * 1. **凭证只在这里读，绝不进渲染层。** 渲染层能拿到的东西等同于公开（§4.3）。
 * 2. **发给渲染层的事件必须过 `toRunEvent` 这道净化**（§12）——
 *    那是"不许出现凭证或完整提示词"这条约束唯一落实的地方。
 */

/** 中断点的原始载荷（来自 video-agent 的节点） */
interface RequirementPayload {
    rows: { field: string; detail: string }[];
}
interface ScenePayload {
    scenes: { goal: string; script: string; visualIntent: string }[];
}
interface MatchPayload {
    matches: {
        goal: string;
        segmentId: string | null;
        assetPath: string | null;
        abandoned: boolean;
    }[];
}

/**
 * 内部事件 → 发往渲染层的事件。
 *
 * **这是安全边界，不是格式转换。** 三件事在这里发生：
 * - `awaiting_input` 的载荷按节点拆成两种明确的事件，渲染层不用再猜 payload 形状
 * - 素材**只给文件名不给完整路径**——路径会暴露用户的目录结构
 * - 其余事件逐字段挑着抄，而不是 `{...event}` 展开。
 *   展开的话，哪天有人往 `GraphEvent` 上加个带敏感内容的字段就直接漏出去了
 */
export function toRunEvent(
    runId: string,
    event: GraphEvent
): AgentRunEvent | null {
    switch (event.type) {
        case 'node_start':
            return { type: 'node_start', runId, node: event.node };
        case 'node_finish':
            return { type: 'node_finish', runId, node: event.node };
        case 'progress':
            return {
                type: 'progress',
                runId,
                node: event.node,
                done: event.done,
                total: event.total,
                ...(event.label !== undefined ? { label: event.label } : {})
            };
        case 'analysis':
            // 逐字段复制，不整对象透传（同 requirements）
            return {
                type: 'analysis',
                runId,
                inputKind: event.inputKind,
                outline: [...event.outline],
                theme: event.theme,
                audience: event.audience,
                tone: event.tone,
                keyPoints: [...event.keyPoints],
                materialFit: event.materialFit
            };

        case 'requirements':
            // 逐行复制：**净化边界**上不做整对象透传，
            // 将来 GraphEvent 上加字段才不会顺手漏进渲染层
            return {
                type: 'requirements',
                runId,
                rows: event.rows.map((row) => ({
                    field: row.field,
                    detail: row.detail
                }))
            };

        case 'partial':
            return {
                type: 'partial',
                runId,
                node: event.node,
                text: event.text
            };
        case 'decision':
            return {
                type: 'decision',
                runId,
                node: event.node,
                summary: event.summary
            };
        case 'warning':
            return {
                type: 'warning',
                runId,
                node: event.node,
                message: event.message
            };
        case 'error':
            return { type: 'error', runId, message: event.message };
        case 'finished':
            return { type: 'finished', runId, savedPath: event.savedPath };
        case 'awaiting_input': {
            if (event.node === 'RequirementApproval') {
                const payload = event.payload as RequirementPayload;
                return {
                    type: 'awaiting_requirements',
                    runId,
                    rows: payload.rows.map((row) => ({
                        field: row.field,
                        detail: row.detail
                    }))
                };
            }
            if (event.node === 'SceneApproval') {
                const payload = event.payload as ScenePayload;
                const scenes: ScenePreview[] = payload.scenes.map((scene) => ({
                    goal: scene.goal,
                    script: scene.script,
                    visualIntent: scene.visualIntent
                }));
                return { type: 'awaiting_scenes', runId, scenes };
            }
            const payload = event.payload as MatchPayload;
            const matches: MatchPreview[] = payload.matches.map((match) => ({
                goal: match.goal,
                segmentId: match.segmentId,
                // 只给文件名：完整路径会暴露用户的目录结构
                assetName: match.assetPath
                    ? path.basename(match.assetPath)
                    : null,
                abandoned: match.abandoned
            }));
            return { type: 'awaiting_matches', runId, matches };
        }
        default:
            return null;
    }
}

/**
 * 没配模型凭证就**别开跑**。
 *
 * 不拦的话，图会用 Mock provider 一路走到第三个节点，然后抛出
 * 「MockModelProvider 没有为任务「CreativeBrief」注册应答」——
 * 用户看到的是一句他完全无从下手的内部错误，而真正的问题只是少了一个文件。
 */
export function assertModelConfigured(
    provider: string,
    /** 启动时找过的 .env 位置。**列出来**，否则"放了却读不到"只能靠猜 */
    searchedEnvFiles: readonly string[] = []
): void {
    if (provider === 'ark') return;

    const where =
        searchedEnvFiles.length > 0
            ? `\n\n启动时在这些位置找过 .env（都没读到有效配置）：\n` +
              searchedEnvFiles.map((file) => `  ${file}`).join('\n')
            : '';

    throw new Error(
        '没有配置模型凭证，无法创作。请建一个 .env 文件，写入：\n' +
            'LLM_PROVIDER=ark\n' +
            'ARK_API_KEY=你的方舟 API Key\n' +
            'LLM_MODEL=你要用的模型 ID' +
            where
    );
}

/**
 * 按配置建一个模型 provider，**凭证不对就给人话**。
 *
 * ## 为什么不能直接 `loadLlmConfig` 再 `assertModelConfigured`
 *
 * 那个顺序是错的，而且错得很隐蔽：`loadLlmConfig` 自己会抛
 * 「LLM 配置不可用：apiKey：Invalid input」——`LLM_PROVIDER=ark` 却没 key
 * 就是这种情况。于是 `assertModelConfigured` 那句能照着做的话
 * **永远没机会说出口**，用户拿到的是一句 zod 原文：
 * 他既不知道 apiKey 对应哪个环境变量，也不知道 "invalid" 指的是"空的"。
 *
 * 这条是 `pnpm e2e --live` 跑出来的。两个调用点（改一镜、改分镜）
 * 原本各写了一遍同样的顺序，所以收进这里——各写各的迟早只修好一处。
 */
export function resolveModelProvider(
    env: Record<string, string | undefined>,
    searchedEnvFiles: readonly string[] = []
): ModelProvider {
    let config;
    try {
        config = loadLlmConfig(env);
    } catch {
        // 配置装不起来，归根到底就是凭证没配好。把那句能照着做的话说出来
        assertModelConfigured('mock', searchedEnvFiles);
        throw new Error('没有配置模型凭证');
    }

    assertModelConfigured(config.provider, searchedEnvFiles);
    const primary = new ArkChatModelProvider({ config });

    /**
     * 配了备用服务就套一层厂商级降级。
     *
     * **接在这里是为了让业务代码一个字都不用改**：refine、revise、创作三条路
     * 都从这个函数拿 provider，它们只认 `ModelProvider` 接口。
     *
     * 备用没配就原样返回主服务——不编一个出来。而备用**配错了会抛**
     * （`loadFallbackLlmConfig` 里校验）：半配置比不配置更糟，
     * 以为有退路、真出事时才发现没有。
     */
    const fallback = loadFallbackLlmConfig(env);
    if (!fallback) return primary;

    return new FailoverModelProvider([
        primary,
        // 名字必须不同，否则事件里是"从 ark 切到 ark"
        new ArkChatModelProvider({ config: fallback, name: 'fallback' })
    ]);
}

/**
 * 定下这次创作用哪个音色。
 *
 * **渲染层送来的值不可信**：它是 IPC 参数，任何东西都可能出现在那里。
 * 过一遍白名单，不认识就退回配置里的音色——原样转发只会在合成那步换来
 * 一个看不懂的服务端错误，而那时已经跑了十几个节点。
 *
 * ## 白名单要认自定义音色
 *
 * 只对着官方目录查（`isKnownVoice`）的话，用户选了自己克隆的音色，
 * 这里会**悄悄退回官方音色**——创作照常跑完，出来的片子却不是他要的声音，
 * 而且全程没有任何一处说过话。
 *
 * 这正是 `makeVoiceProvider` 那段注释警告的第三条路：试听能出自己的声音，
 * 点创作却变回官方音色。所以这里认 `isUsableVoiceId`（官方目录 + 自定义前缀），
 * 走哪个引擎交给分流去判。
 */
export function resolveVoiceId(
    requested: string | undefined,
    env: Record<string, string | undefined>
): string {
    if (requested !== undefined && isUsableVoiceId(requested)) return requested;
    return env['TTS_VOICE'] ?? DEFAULT_VOICE_ID;
}

export interface AgentRunnerOptions {
    /** 素材索引库路径 */
    indexDbPath: string;
    /** checkpoint 库路径 */
    checkpointDbPath: string;
    /** 工程根目录，每次创作在下面建一个子目录 */
    projectsRoot: string;
    /** 配音落盘目录 */
    audioDir: string;
    /** 事件出口。主进程接到 `webContents.send` */
    emit: (event: AgentRunEvent) => void;
    env?: Record<string, string | undefined>;
    /** 启动时找过的 .env 位置。只用于缺凭证时的报错，不读内容 */
    envSearchPaths?: readonly string[];
    /**
     * 取当前选中的素材。
     *
     * **必须传**：不传的话图会拿整个索引库去配画面，
     * 而库里可能还留着上次索引的别的目录——用户只选了一个文件，
     * 准备阶段却报"3 个文件、3 个片段"，就是这么来的。
     */
    mediaPaths?: () => readonly string[];
    /**
     * 自定义音色的参考音频在哪。
     *
     * 不传就是没接音色库——此时选了自定义音色会在分流那一层被拦下，
     * 而不是走到合成请求才失败。接在 `voice-samples` 的 `samplePathOf` 上。
     */
    referenceOf?: (sampleId: string) => Promise<string | null>;
    /**
     * 语音缓存元数据库。**可选**——不给就退回只看文件在不在。
     *
     * 传函数而不是实例是为了**用到才开库**：只是列个工程的会话
     * 不该为此建目录、跑 DDL。
     */
    ttsCache?: () => TtsCacheStore;
}

interface RunRecord {
    runId: string;
    status: RunStatus;
    node: string | null;
    savedPath: string | null;
    error: string | null;
    projectDir: string;
    graph: ReturnType<typeof buildAgentGraph>;
    db: MediaIndexDb;
    saver: SqliteWasmSaver;
}

export class AgentRunner {
    private readonly options: AgentRunnerOptions;
    private readonly runs = new Map<string, RunRecord>();

    constructor(options: AgentRunnerOptions) {
        this.options = options;
    }

    /** 当前有哪些运行。主窗口重开后靠它恢复界面 */
    snapshot(runId: string): RunSnapshot | null {
        const run = this.runs.get(runId);
        if (!run) return null;
        return {
            runId: run.runId,
            status: run.status,
            node: run.node,
            savedPath: run.savedPath,
            error: run.error
        };
    }

    /**
     * 发起一次创作。
     *
     * `voiceId` 来自界面，会先过 `resolveVoiceId` 的白名单——理由见那里。
     */
    async start(prompt: string, voiceId?: string): Promise<{ runId: string }> {
        const runId = `run_${randomUUID().replace(/-/g, '').slice(0, 12)}`;
        const projectDir = path.join(this.options.projectsRoot, runId);

        const env = this.options.env ?? process.env;
        // 凭证只在这里读。配置非法要在**开跑之前**报出来，
        // 而不是等跑到第 4 个节点才崩
        const llmConfig = loadLlmConfig(env);
        // 缺凭证要在开跑之前说清楚，而不是让图跑到第三个节点抛内部错误
        assertModelConfigured(
            llmConfig.provider,
            this.options.envSearchPaths ?? []
        );

        const db = MediaIndexDb.open(this.options.indexDbPath);
        const saver = SqliteWasmSaver.open(this.options.checkpointDbPath);

        // 两处都要用，各算一遍迟早会出现"发给引擎的"和"写进工程的"不是同一个
        const chosenVoiceId = resolveVoiceId(voiceId, env);

        const deps: GraphDeps = {
            db,
            model:
                llmConfig.provider === 'ark'
                    ? new ArkChatModelProvider({ config: llmConfig })
                    : new MockModelProvider(),
            /**
             * 走**同一个分流入口**：官方音色给火山，自定义音色给本地 IndexTTS2。
             *
             * 这里曾经直接用 `makeTtsProvider`，于是选了自定义音色也只会
             * 用官方音色合成——而界面上完全看不出来。
             *
             * 没配凭证时仍然退回 Mock（长度正确的静音，管线能跑通但听不见），
             * 预览区会把这件事说出来。
             */
            tts: makeVoiceProvider({
                env,
                outDir: this.options.audioDir,
                voiceId: chosenVoiceId,
                ...(this.options.referenceOf
                    ? { referenceOf: this.options.referenceOf }
                    : {}),
                // 整条链里**这里重复合成最多**：repair 回边、时长回压都会
                // 再走一遍 Tts 节点，而绝大多数分镜的文案一个字都没改
                ...(this.options.ttsCache
                    ? { cache: this.options.ttsCache() }
                    : {})
            }),
            voiceId: chosenVoiceId,
            projectDir,
            mediaPaths: this.options.mediaPaths?.() ?? [],
            onEvent: (event) => this.handle(runId, event)
        };

        const run: RunRecord = {
            runId,
            status: 'running',
            node: null,
            savedPath: null,
            error: null,
            projectDir,
            graph: buildAgentGraph({ deps, checkpointer: saver }),
            db,
            saver
        };
        this.runs.set(runId, run);

        // **不 await**：图会停在第一个中断点，而界面要立刻拿到 runId 开始显示进度
        void this.drive(run, { runId, prompt });
        return { runId };
    }

    /** 这次能读的素材根。预览的自定义协议按它放行 */
    mediaRoots(): readonly string[] {
        return this.options.mediaPaths?.() ?? [];
    }

    async approve(runId: string, answer: ApprovalAnswer): Promise<void> {
        const run = this.runs.get(runId);
        if (!run) throw new Error(`没有这个运行：${runId}`);
        if (
            run.status !== 'awaiting_requirements' &&
            run.status !== 'awaiting_scenes' &&
            run.status !== 'awaiting_matches'
        ) {
            throw new Error(`运行 ${runId} 当前不在等待确认（${run.status}）`);
        }

        run.status = 'running';
        const resume =
            answer.node === 'RequirementApproval'
                ? { action: 'approve' }
                : answer.node === 'SceneApproval'
                  ? answer.action === 'modify'
                      ? { action: 'modify', scripts: answer.scripts }
                      : { action: 'approve' }
                  : answer.action === 'reject'
                    ? {
                          action: 'reject',
                          rejectedIndexes: answer.rejectedIndexes
                      }
                    : { action: 'approve' };

        void this.drive(run, new Command({ resume }));
    }

    async cancel(runId: string): Promise<void> {
        const run = this.runs.get(runId);
        if (!run) return;
        run.status = 'cancelled';
        this.options.emit({ type: 'cancelled', runId });
        this.dispose(run);
    }

    /** 关窗或退出时释放所有运行持有的数据库句柄 */
    disposeAll(): void {
        for (const run of this.runs.values()) this.dispose(run);
        this.runs.clear();
    }

    private dispose(run: RunRecord): void {
        try {
            run.db.close();
        } catch {
            /* 已经关过了 */
        }
        try {
            run.saver.close();
        } catch {
            /* 已经关过了 */
        }
    }

    /**
     * 推一次图，直到它停下来（中断或跑完）。
     *
     * 图抛错时**必须转成 error 事件**，否则就是一个没人接的 rejection，
     * 界面上表现为"进度条卡住，永远不动"。
     */
    private async drive(run: RunRecord, input: unknown): Promise<void> {
        const config = {
            configurable: { thread_id: run.runId },
            // 图里有 repair 环，默认 25 步不够
            recursionLimit: 80
        };
        try {
            await run.graph.invoke(input as never, config);

            const state = await run.graph.getState(config);
            if (state.next.length === 0 && run.status === 'running') {
                run.status = 'finished';
                this.dispose(run);
            }
        } catch (error) {
            const message =
                error instanceof Error ? error.message : String(error);
            run.status = 'failed';
            run.error = message;
            this.options.emit({ type: 'error', runId: run.runId, message });
            this.dispose(run);
        }
    }

    private handle(runId: string, event: GraphEvent): void {
        const run = this.runs.get(runId);
        if (!run) return;

        if (event.type === 'node_start') run.node = event.node;
        if (event.type === 'awaiting_input') {
            run.status =
                event.node === 'RequirementApproval'
                    ? 'awaiting_requirements'
                    : event.node === 'SceneApproval'
                      ? 'awaiting_scenes'
                      : 'awaiting_matches';
        }
        if (event.type === 'finished') {
            run.savedPath = event.savedPath;
        }

        const wire = toRunEvent(runId, event);
        if (wire) this.options.emit(wire);
    }
}
