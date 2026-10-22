import { contextBridge, ipcRenderer } from 'electron';

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
    RunSnapshot,
    StartRunResult,
    VoiceEngineStatus,
    VoicePreview,
    VoiceRegenerateEvent,
    VoiceSample
} from './agent-ipc';
import {
    AGENT_CHANNELS,
    MEDIA_CHANNELS,
    PROJECT_CHANNELS,
    VOICE_CHANNELS
} from './agent-ipc';

// 新增能力时按 magicut-electron-bridge skill 的链路走，**四处同步**：
// ipcMain.handle → 此处 invoke → magicut.env.d.ts 全局类型 → eslint globals。
const magicutAPI = {
    ping: async () => ({ pong: true }),

    videoAgent: {
        start: (prompt: string, voiceId?: string): Promise<StartRunResult> =>
            ipcRenderer.invoke(AGENT_CHANNELS.start, { prompt, voiceId }),

        approve: (runId: string, answer: ApprovalAnswer): Promise<void> =>
            ipcRenderer.invoke(AGENT_CHANNELS.approve, runId, answer),

        /**
         * 停在分镜确认时，按一句要求让模型改一版文案。
         *
         * 返回新文案，**不放行**——改成什么样用户得先看见。
         */
        reviseScenes: (
            instruction: string,
            scripts: string[]
        ): Promise<string[]> =>
            ipcRenderer.invoke(
                AGENT_CHANNELS.reviseScenes,
                instruction,
                scripts
            ),

        cancel: (runId: string): Promise<void> =>
            ipcRenderer.invoke(AGENT_CHANNELS.cancel, runId),

        state: (runId: string): Promise<RunSnapshot | null> =>
            ipcRenderer.invoke(AGENT_CHANNELS.state, runId),

        /**
         * 订阅进度事件。
         *
         * **必须返回退订函数。** 不返回的话，每次切页面都会再挂一个监听，
         * 监听器只增不减——表现为进度条越跳越快、事件重复处理
         * （plan.md §12.3 专门写过这条）。
         */
        onEvent: (listener: (event: AgentRunEvent) => void): (() => void) => {
            const handler = (
                _event: Electron.IpcRendererEvent,
                payload: AgentRunEvent
            ): void => listener(payload);
            ipcRenderer.on(AGENT_CHANNELS.event, handler);
            return () => {
                ipcRenderer.off(AGENT_CHANNELS.event, handler);
            };
        }
    },

    media: {
        /** 打开系统目录选择框。用户取消返回 null */
        pick: (): Promise<MediaStatus | null> =>
            ipcRenderer.invoke(MEDIA_CHANNELS.pick),

        status: (): Promise<MediaStatus> =>
            ipcRenderer.invoke(MEDIA_CHANNELS.status),

        /** 清空这次的选择。选错了要能一键回到"什么都没选" */
        clear: (): Promise<MediaStatus> =>
            ipcRenderer.invoke(MEDIA_CHANNELS.clear),

        /** 扫描 + ffprobe + 抽帧。本地操作，不花钱 */
        index: (): Promise<MediaStatus> =>
            ipcRenderer.invoke(MEDIA_CHANNELS.index),

        /** 关键帧打标。**要调模型，按量计费** */
        tag: (): Promise<MediaStatus> => ipcRenderer.invoke(MEDIA_CHANNELS.tag),

        /** 订阅进度。同 videoAgent，**必须返回退订函数** */
        onEvent: (listener: (event: MediaEvent) => void): (() => void) => {
            const handler = (
                _event: Electron.IpcRendererEvent,
                payload: MediaEvent
            ): void => listener(payload);
            ipcRenderer.on(MEDIA_CHANNELS.event, handler);
            return () => {
                ipcRenderer.off(MEDIA_CHANNELS.event, handler);
            };
        }
    },

    voices: {
        /** 用某个音色合成一小段样本，拿回来直接播 */
        preview: (voiceId: string, speed?: number): Promise<VoicePreview> =>
            ipcRenderer.invoke(VOICE_CHANNELS.preview, voiceId, speed),

        /** 整条片子的口播重新合成一遍。返回重排之后的工程 */
        regenerate: (dirName: string, voiceId: string): Promise<VideoProject> =>
            ipcRenderer.invoke(VOICE_CHANNELS.regenerate, dirName, voiceId),

        /** 自定义音色库：列出 / 添加（开文件框）/ 删除 / 读出来试听 */
        samples: {
            list: (): Promise<VoiceSample[]> =>
                ipcRenderer.invoke(VOICE_CHANNELS.sampleList),

            add: (): Promise<VoiceSample[]> =>
                ipcRenderer.invoke(VOICE_CHANNELS.sampleAdd),

            remove: (id: string): Promise<VoiceSample[]> =>
                ipcRenderer.invoke(VOICE_CHANNELS.sampleRemove, id),

            read: (
                id: string
            ): Promise<{ dataUrl: string; durationMs: number }> =>
                ipcRenderer.invoke(VOICE_CHANNELS.sampleRead, id),

            /** 本地复刻引擎现在能不能用。界面据此决定说哪句话 */
            engine: (): Promise<VoiceEngineStatus> =>
                ipcRenderer.invoke(VOICE_CHANNELS.sampleEngine)
        },

        /** 订阅合成进度。同 videoAgent，**必须返回退订函数** */
        onProgress: (
            listener: (event: VoiceRegenerateEvent) => void
        ): (() => void) => {
            const handler = (
                _event: Electron.IpcRendererEvent,
                payload: VoiceRegenerateEvent
            ): void => listener(payload);
            ipcRenderer.on(VOICE_CHANNELS.event, handler);
            return () => {
                ipcRenderer.off(VOICE_CHANNELS.event, handler);
            };
        }
    },

    projects: {
        list: (): Promise<ProjectSummary[]> =>
            ipcRenderer.invoke(PROJECT_CHANNELS.list),

        load: (dirName: string): Promise<VideoProject> =>
            ipcRenderer.invoke(PROJECT_CHANNELS.load, dirName),

        /** 给某一镜记一条修改要求。返回写完之后的工程 */
        request: (
            dirName: string,
            request: { sceneId: string | null; text: string }
        ): Promise<VideoProject> =>
            ipcRenderer.invoke(PROJECT_CHANNELS.request, dirName, request),

        /** 按一句要求把某一镜真的重做一遍。返回改完之后的工程 */
        refineScene: (
            dirName: string,
            sceneId: string,
            instruction: string,
            speed?: number
        ): Promise<VideoProject> =>
            ipcRenderer.invoke(
                PROJECT_CHANNELS.refineScene,
                dirName,
                sceneId,
                instruction,
                speed
            ),

        /** 订阅改一镜的进度。同 videoAgent，**必须返回退订函数** */
        onRefineProgress: (
            listener: (stage: RefineStage) => void
        ): (() => void) => {
            const handler = (
                _event: Electron.IpcRendererEvent,
                payload: RefineStage
            ): void => listener(payload);
            ipcRenderer.on(PROJECT_CHANNELS.refineEvent, handler);
            return () => {
                ipcRenderer.off(PROJECT_CHANNELS.refineEvent, handler);
            };
        },

        /** 改一条字幕样式。返回写完之后的工程 */
        saveSubtitleStyle: (
            dirName: string,
            styleId: string,
            style: SubtitleStyle
        ): Promise<VideoProject> =>
            ipcRenderer.invoke(
                PROJECT_CHANNELS.subtitleStyle,
                dirName,
                styleId,
                style
            ),

        /** 改配音轨音量。返回写完之后的工程 */
        saveVoiceGain: (
            dirName: string,
            gainDb: number
        ): Promise<VideoProject> =>
            ipcRenderer.invoke(PROJECT_CHANNELS.voiceGain, dirName, gainDb),

        /** 整份工程写回去。改结构（分割、删镜）只能这么存 */
        save: (dirName: string, project: VideoProject): Promise<VideoProject> =>
            ipcRenderer.invoke(PROJECT_CHANNELS.save, dirName, project),

        /** 渲染导出。保存位置由主进程的对话框问，渲染层不碰路径 */
        export: (dirName: string): Promise<ExportResult> =>
            ipcRenderer.invoke(PROJECT_CHANNELS.export, dirName),

        /** 订阅渲染进度。同 videoAgent，**必须返回退订函数** */
        onExportProgress: (
            listener: (event: ExportProgressEvent) => void
        ): (() => void) => {
            const handler = (
                _event: Electron.IpcRendererEvent,
                payload: ExportProgressEvent
            ): void => listener(payload);
            ipcRenderer.on(PROJECT_CHANNELS.exportEvent, handler);
            return () => {
                ipcRenderer.off(PROJECT_CHANNELS.exportEvent, handler);
            };
        },

        remove: (dirName: string): Promise<void> =>
            ipcRenderer.invoke(PROJECT_CHANNELS.remove, dirName)
    }
};

export type MagicutApi = typeof magicutAPI;

contextBridge.exposeInMainWorld('magicutAPI', magicutAPI);
