import type {
    SubtitleStyle,
    VideoProject
} from '@magicut-react-demo/video-project';

import type {
    AgentRunEvent,
    ApprovalAnswer,
    ExportProgressEvent,
    ExportResult,
    MediaEvent,
    MediaStatus,
    ProjectSummary,
    RefineStage,
    StartRunResult,
    VoiceEngineStatus,
    VoicePreview,
    VoiceRegenerateEvent,
    VoiceSample
} from '@/client/agent-ipc';
import type { MediaKind } from '@/client/media-url';
import { MEDIA_SCHEME } from '@/client/media-url';

/**
 * 主进程桥接的访问层。
 *
 * ## 为什么不直接用 `window.magicutAPI`
 *
 * 渲染层有三种运行环境，只有第一种有桥：
 *
 * | 环境 | 有 `magicutAPI` 吗 |
 * |---|---|
 * | Electron 里真跑 | 有 |
 * | vitest + jsdom（组件测试） | **没有** |
 * | `pnpm ui:shot` 的离屏浏览器 | **没有** |
 *
 * 组件里散着写 `window.magicutAPI?.xxx` 的话，后两种环境下的行为就成了
 * 一堆隐式的 undefined 分支，测起来全是噪声。收在这里，
 * **"没有桥"变成一个明确的状态**，页面可以据此显示"请在桌面端打开"。
 */

export interface AgentBridge {
    start(prompt: string, voiceId?: string): Promise<StartRunResult>;
    approve(runId: string, answer: ApprovalAnswer): Promise<void>;
    /**
     * 停在分镜确认时，按一句要求让模型改一版文案。
     *
     * 返回新文案，**不放行**——改成什么样用户得先看见再决定，
     * 放行之后配素材与合成的钱就花出去了。
     */
    reviseScenes(instruction: string, scripts: string[]): Promise<string[]>;
    cancel(runId: string): Promise<void>;
    /** 返回退订函数。不退订的话监听器会随页面切换越积越多（§12.3） */
    onEvent(listener: (event: AgentRunEvent) => void): () => void;
}

export interface MediaBridge {
    pick(): Promise<MediaStatus | null>;
    status(): Promise<MediaStatus>;
    clear(): Promise<MediaStatus>;
    index(): Promise<MediaStatus>;
    tag(): Promise<MediaStatus>;
    /** 返回退订函数。不退订的话监听器会随页面切换越积越多（§12.3） */
    onEvent(listener: (event: MediaEvent) => void): () => void;
}

export interface ProjectBridge {
    list(): Promise<ProjectSummary[]>;
    load(dirName: string): Promise<VideoProject>;
    request(
        dirName: string,
        request: { sceneId: string | null; text: string }
    ): Promise<VideoProject>;
    /**
     * 按一句要求把某一镜真的重做一遍：改文案、重念、重排。
     *
     * 和 `request` 的分工：那条只是**记下来**，这条是**真改**。
     * 两条都留着——"记一笔回头再说"和"现在就改"是两种真实的意图。
     */
    refineScene(
        dirName: string,
        sceneId: string,
        instruction: string,
        /** 语速倍率。跟着整条片子走，只有本地引擎认 */
        speed?: number
    ): Promise<VideoProject>;
    /** 返回退订函数。不退订的话监听器会随页面切换越积越多（§12.3） */
    onRefineProgress(listener: (stage: RefineStage) => void): () => void;
    saveSubtitleStyle(
        dirName: string,
        styleId: string,
        style: SubtitleStyle
    ): Promise<VideoProject>;
    saveVoiceGain(dirName: string, gainDb: number): Promise<VideoProject>;
    save(dirName: string, project: VideoProject): Promise<VideoProject>;
    export(dirName: string): Promise<ExportResult>;
    onExportProgress(
        listener: (event: ExportProgressEvent) => void
    ): () => void;
    remove(dirName: string): Promise<void>;
}

function api(): Window['magicutAPI'] | null {
    return typeof window === 'undefined' ? null : (window.magicutAPI ?? null);
}

/**
 * 工程里的某个素材 → 预览能播的 URL。
 *
 * 走主进程注册的自定义 scheme（见 client/media-protocol.ts）。
 * 两件事在这里定死：
 *
 * 1. **不用 `file://`**——开发时渲染层从 http 加载会被同源策略挡下，
 *    打包后页面本身才是 `file://`，两种形态行为不同迟早出事。
 * 2. **URL 里只有 id，没有路径。** 渲染层根本不该知道素材在磁盘哪儿；
 *    由主进程按工程 JSON 把 id 翻译成路径，越权就从"要不要拦"
 *    变成了"根本表达不出来"。
 *
 * 没有桥（浏览器、`ui:shot`）时返回 null——那边本来也读不到本地文件。
 */
export function mediaUrl(
    projectId: string | null | undefined,
    kind: MediaKind,
    assetId: string | null | undefined
): string | null {
    if (!projectId || !assetId || !hasBridge()) return null;
    return (
        `${MEDIA_SCHEME}://project/${encodeURIComponent(projectId)}` +
        `/${kind}/${encodeURIComponent(assetId)}`
    );
}

/** 有没有桥。页面用它区分"还没加载完"与"根本不在桌面端" */
export function hasBridge(): boolean {
    return api() !== null;
}

export function agentBridge(): AgentBridge | null {
    return api()?.videoAgent ?? null;
}

export function mediaBridge(): MediaBridge | null {
    return api()?.media ?? null;
}

/**
 * 把主进程那头的错误翻译成用户能据此行动的一句话。
 *
 * ## 为什么专门认「没有这个 handler」
 *
 * Electron Forge 的开发服务**只热更新渲染进程**。新增一条 IPC 通道之后，
 * 窗口里跑的仍是旧的主进程 bundle，于是调用会以
 * `No handler registered for '…'` 失败。
 *
 * 这句话对用户毫无意义——他看到的是"保存失败"，然后开始怀疑是不是磁盘满了、
 * 是不是工程坏了。而正确的动作只有一个：**重启应用**。
 * 不翻译的话，这个误导每加一条通道就要重演一次。
 */
export function describeBridgeError(error: unknown): string {
    const message = error instanceof Error ? error.message : String(error);
    return /No handler registered/i.test(message)
        ? '这条通道在当前运行的主进程里还不存在，重启应用即可（开发时主进程不会热更新）'
        : message;
}

export function projectBridge(): ProjectBridge | null {
    return api()?.projects ?? null;
}

export interface VoiceBridge {
    /** `speed` 只有本地引擎认，官方音色那条会原样忽略 */
    preview(voiceId: string, speed?: number): Promise<VoicePreview>;
    regenerate(
        dirName: string,
        voiceId: string,
        speed?: number
    ): Promise<VideoProject>;
    onProgress(listener: (event: VoiceRegenerateEvent) => void): () => void;
    /**
     * 自定义音色库。
     *
     * 样本文件归应用管（复制进 userData），所以这里**只认 id**，
     * 渲染层拿不到也不该拿到本地路径——和媒体协议是同一条规矩。
     */
    samples: {
        list(): Promise<VoiceSample[]>;
        /** 开文件框挑一个。用户取消时原样返回当前列表 */
        add(): Promise<VoiceSample[]>;
        remove(id: string): Promise<VoiceSample[]>;
        read(id: string): Promise<{ dataUrl: string; durationMs: number }>;
        /** 本地复刻引擎现在能不能用。界面据此决定说哪句话 */
        engine(): Promise<VoiceEngineStatus>;
    };
}

/**
 * 试听用的桥。
 *
 * 没有桥时返回 null，调用方把试听按钮置灰——浏览器里本来就合成不了，
 * 让它看着能点只会换来一个点不出反应的按钮。
 */
export function voiceBridge(): VoiceBridge | null {
    return api()?.voices ?? null;
}
