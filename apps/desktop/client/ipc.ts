import type { BrowserWindow } from 'electron';
import { app, dialog, ipcMain } from 'electron';
import path from 'node:path';

import { extensionsOfKind } from '@magicut-react-demo/media-index';
// 合成器已经搬到 `scene-synthesizer.ts`，这里不再直接建 provider
import { checkIndexTts, TtsCacheStore } from '@magicut-react-demo/video-agent';
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
    StartRunInput,
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
import { AgentRunner } from './agent-runner';
import { exportVideo } from './export-video';
import { MediaRunner } from './media-runner';
import {
    appendRequest,
    listProjects,
    readProject,
    removeProject,
    saveSubtitleStyle,
    saveVoiceGain,
    saveWholeProject
} from './project-store';
import { refineScene } from './refine-scene';
import { regenerateVoice } from './regenerate-voice';
import { reviseScenes } from './revise-scenes';
import { makeSceneSynthesizer } from './scene-synthesizer';
import { synthesizeVoicePreview } from './voice-preview';
import {
    addSample,
    listSamples,
    readSample,
    removeSample,
    samplePathOf
} from './voice-samples';

/**
 * IPC 注册（B10）。
 *
 * 链路按 `magicut-electron-bridge` 的约定走，**四处同步**：
 * `ipcMain.handle`（这里）→ preload `invoke` → `magicut.env.d.ts` 全局类型
 * → eslint globals。漏一处就是"渲染层调了个不存在的方法"。
 *
 * ⚠️ **凭证只在主进程读**（`.env` 经 dotenv 载入 `process.env`），
 * 一个字节都不往渲染层送。
 */

export interface AppPaths {
    /** 所有工程的根目录 */
    projectsRoot: string;
    /** 素材索引库 */
    indexDbPath: string;
    /** checkpoint 库 */
    checkpointDbPath: string;
    /** 配音落盘目录 */
    audioDir: string;
    /**
     * 语音缓存元数据库。
     *
     * 与音频同目录：**清空 audio 目录等于连库一起清掉**，不会留下一个
     * 满是"命中但文件没了"的索引。
     */
    ttsCacheDbPath: string;
    /** 关键帧缩略图目录 */
    keyframeDir: string;
    /** 设置文件所在目录 */
    userDataDir: string;
    /** 启动时找过的 .env 位置。缺凭证时要把它们列给用户看 */
    envSearchPaths?: readonly string[];
}

export function resolveAppPaths(
    env: Record<string, string | undefined> = process.env
): AppPaths {
    // userData 是 Electron 给每个应用的可写目录，跨平台都对
    const base = app.getPath('userData');
    return {
        projectsRoot:
            env['MAGICUT_PROJECTS_DIR'] ?? path.join(base, 'projects'),
        indexDbPath:
            env['MEDIA_INDEX_DB'] ?? path.join(base, 'media-index', 'index.db'),
        checkpointDbPath: path.join(base, 'agent', 'checkpoints.db'),
        audioDir: path.join(base, 'audio'),
        ttsCacheDbPath: path.join(base, 'audio', 'cache.db'),
        keyframeDir: path.join(base, 'media-index', 'keyframes'),
        userDataDir: base
    };
}

/**
 * 语音缓存的两道闸门。
 *
 * **2GB**：一份 10 秒 mp3 约 80KB，2GB 装得下两万多段——远超任何一条片子
 * 的量级，却又不至于让用户的磁盘悄悄被吃掉几十 G。
 *
 * **90 天**：比这更久没碰过的文案，多半那个工程已经不做了。
 */
const TTS_CACHE_MAX_BYTES = 2 * 1024 * 1024 * 1024;
const TTS_CACHE_MAX_AGE_DAYS = 90;

/** 从任意错误里取一条能给用户看的消息 */
function messageOf(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

export function registerIpc(
    getWindow: () => BrowserWindow | null,
    paths: AppPaths
): AgentRunner {
    const send = (event: AgentRunEvent): void => {
        const win = getWindow();
        // 窗口已经关了就别发——往销毁的 webContents 上 send 会抛
        if (win && !win.isDestroyed()) {
            win.webContents.send(AGENT_CHANNELS.event, event);
        }
    };

    /**
     * 语音缓存库，**用到才开**。
     *
     * 开库要建目录、跑一次 DDL；没走到合成的那些会话（只是看看工程列表）
     * 不该为此付出代价。开过一次就留着——每次合成都重开会把 LRU 的访问记录
     * 切得零碎，而那正是淘汰策略的依据。
     */
    let cache: TtsCacheStore | null = null;
    const ttsCache = (): TtsCacheStore => {
        if (cache === null) {
            cache = TtsCacheStore.open(paths.ttsCacheDbPath);
            /**
             * 开库时清一次。**放在这里而不是每次合成之后**：
             * 清理要扫全表、删文件，合成路径上每次都做会白白拖慢它；
             * 而缓存涨到超标是以天计的事，一次会话清一次足够。
             */
            const swept = cache.sweep({
                maxTotalBytes: TTS_CACHE_MAX_BYTES,
                maxAgeDays: TTS_CACHE_MAX_AGE_DAYS
            });
            if (swept.expired + swept.evicted > 0) {
                // 清理会**删用户磁盘上的文件**。悄悄做而不留任何痕迹，
                // 等到有人问"我的音频怎么少了"时就无从查起
                // eslint-disable-next-line no-console
                console.info(
                    `[tts-cache] 清理 ${swept.expired} 份过期、` +
                        `${swept.evicted} 份超容量，释放 ` +
                        `${Math.round(swept.freedBytes / 1024 / 1024)}MB`
                );
            }
        }
        return cache;
    };

    const media = new MediaRunner({
        userDataDir: paths.userDataDir,
        indexDbPath: paths.indexDbPath,
        keyframeDir: paths.keyframeDir,
        emit: (event: MediaEvent) => {
            const win = getWindow();
            if (win && !win.isDestroyed()) {
                win.webContents.send(MEDIA_CHANNELS.event, event);
            }
        }
    });

    const runner = new AgentRunner({
        indexDbPath: paths.indexDbPath,
        checkpointDbPath: paths.checkpointDbPath,
        projectsRoot: paths.projectsRoot,
        audioDir: paths.audioDir,
        emit: send,
        envSearchPaths: paths.envSearchPaths ?? [],
        // 图只在**用户这次选的素材**里配画面。不给的话它会拿整个索引库，
        // 而库里可能还留着上次索引的别的目录
        mediaPaths: () => media.status().paths,
        // 创作时也可能选到用户自己克隆的音色，参考音频从音色库取——
        // 不接的话那条路会悄悄退回官方音色
        referenceOf: (sampleId: string) =>
            samplePathOf({ userDataDir: paths.userDataDir }, sampleId),
        // 传函数：只是列个工程的会话不该为此建目录、跑 DDL
        ttsCache
    });

    ipcMain.handle(
        AGENT_CHANNELS.start,
        async (_event, input: StartRunInput): Promise<StartRunResult> =>
            runner.start(input.prompt, input.voiceId)
    );

    ipcMain.handle(
        AGENT_CHANNELS.approve,
        async (_event, runId: string, answer: ApprovalAnswer) => {
            await runner.approve(runId, answer);
        }
    );

    /**
     * 停在分镜确认时，按一句要求让模型改一版文案。
     *
     * **只算、不放行**：新文案交回渲染层填进那几个文本框，由用户看过再决定。
     * 替他点头的话，模型写成什么样他根本没看见，而放行之后配素材与合成的钱
     * 就花出去了。
     */
    ipcMain.handle(
        AGENT_CHANNELS.reviseScenes,
        async (
            _event,
            instruction: string,
            scripts: string[]
        ): Promise<string[]> =>
            reviseScenes({
                instruction,
                scripts,
                // 缺凭证时要把找过的位置列出来，否则"放了却读不到"只能靠猜
                envSearchPaths: paths.envSearchPaths ?? []
            })
    );

    ipcMain.handle(AGENT_CHANNELS.cancel, async (_event, runId: string) => {
        await runner.cancel(runId);
    });

    ipcMain.handle(AGENT_CHANNELS.state, async (_event, runId: string) =>
        runner.snapshot(runId)
    );

    // ── 素材库 ────────────────────────────────────────────────────────────

    ipcMain.handle(
        MEDIA_CHANNELS.pick,
        async (): Promise<MediaStatus | null> => {
            const win = getWindow();
            if (!win) return null;
            const result = await dialog.showOpenDialog(win, {
                title: '选择素材',
                // 挑素材文件，可多选。macOS 上顺带允许挑整个目录——
                // Windows/Linux 的对话框不能同时当文件选择器和目录选择器，
                // 两个都传的话会退化成只能选目录，那就挑不了文件了
                properties:
                    process.platform === 'darwin'
                        ? ['openFile', 'openDirectory', 'multiSelections']
                        : ['openFile', 'multiSelections'],
                /**
                 * **图片和视频一样是素材**：扫描白名单收它、ffprobe 认 `_pipe`
                 * 容器、抽帧对图片取 t=0、打标照走。一张图配一镜画面完全成立，
                 * 不是非得有 .mp4。
                 *
                 * 三档都从 media-index 的魔数规则表取，**不在这里抄第二份**——
                 * 之前这里硬写了一串视频扩展名，图片于是在选择器里是灰的：
                 * 管线早就支持，用户却根本点不中。
                 */
                filters: [
                    {
                        name: '素材',
                        extensions: extensionsOfKind(['video', 'image'], {
                            withDot: false
                        })
                    },
                    {
                        name: '视频',
                        extensions: extensionsOfKind(['video'], {
                            withDot: false
                        })
                    },
                    {
                        name: '图片',
                        extensions: extensionsOfKind(['image'], {
                            withDot: false
                        })
                    }
                ],
                buttonLabel: '用这些素材'
            });
            if (result.canceled || result.filePaths.length === 0) return null;
            return media.setPaths(result.filePaths);
        }
    );

    ipcMain.handle(
        MEDIA_CHANNELS.clear,
        async (): Promise<MediaStatus> => media.setPaths([])
    );

    ipcMain.handle(
        MEDIA_CHANNELS.status,
        async (): Promise<MediaStatus> => media.status()
    );

    ipcMain.handle(
        MEDIA_CHANNELS.index,
        async (): Promise<MediaStatus> => media.index()
    );

    ipcMain.handle(
        MEDIA_CHANNELS.tag,
        async (): Promise<MediaStatus> => media.tag()
    );

    // ── 自定义音色库 ──────────────────────────────────────────────────────
    //
    // 样本文件归应用管（复制进 userData），所以**渲染层只说 id**，
    // 和媒体协议是同一条规矩

    const sampleStore = { userDataDir: paths.userDataDir };

    /**
     * 自定义音色的参考音频在哪。
     *
     * 试听与整条重配**共用这一个**：IndexTTS2 是零样本的，每次合成都要读
     * 参考音频，两条路各写一份查找逻辑的话，迟早出现"试听出得来声、
     * 生成却说找不到音色"这种对不上的状态。
     */
    const referenceOf = (sampleId: string): Promise<string | null> =>
        samplePathOf(sampleStore, sampleId);

    /**
     * 试听。
     *
     * **凭证只在这一侧读**：provider 从 `process.env` 取 key 与本地引擎地址，
     * 渲染层只说一个音色 id，连端点都不知道。
     */
    ipcMain.handle(
        VOICE_CHANNELS.preview,
        async (
            _event,
            voiceId: string,
            speed?: number
        ): Promise<VoicePreview> =>
            synthesizeVoicePreview({
                voiceId,
                ...(speed === undefined ? {} : { speed }),
                // 和正式配音同一个目录：同一个音色的样本合成过一次就留在盘上
                outDir: path.join(paths.audioDir, 'preview'),
                referenceOf
            })
    );

    /**
     * 用指定音色把整条片子的口播重新合成一遍，并按新时长重排时间线。
     *
     * 合成与重排**绑在一起**：中间那个"换了音频但还没重排"的状态是不合法的，
     * 任何一步失败都不该把它留在盘上。
     */
    ipcMain.handle(
        VOICE_CHANNELS.regenerate,
        async (
            _event,
            dirName: string,
            voiceId: string,
            speed?: number
        ): Promise<VideoProject> =>
            regenerateVoice({
                root: paths.projectsRoot,
                dirName,
                voiceId,
                audioDir: paths.audioDir,
                referenceOf,
                // 语速只有本地引擎认，官方音色那条会原样忽略
                ...(speed === undefined ? {} : { speed }),
                onProgress: (progress: VoiceRegenerateEvent) => {
                    const win = getWindow();
                    if (win && !win.isDestroyed()) {
                        win.webContents.send(VOICE_CHANNELS.event, progress);
                    }
                }
            })
    );

    ipcMain.handle(
        VOICE_CHANNELS.sampleList,
        async (): Promise<VoiceSample[]> => listSamples(sampleStore)
    );

    ipcMain.handle(
        VOICE_CHANNELS.sampleAdd,
        async (): Promise<VoiceSample[]> => {
            const win = getWindow();
            if (!win) return listSamples(sampleStore);

            const picked = await dialog.showOpenDialog(win, {
                title: '选择人声样本',
                properties: ['openFile'],
                filters: [
                    {
                        name: '音频',
                        extensions: ['mp3', 'wav', 'm4a', 'aac', 'flac', 'ogg']
                    }
                ],
                buttonLabel: '收进音色库'
            });
            // 取消不是故障：原样返回当前列表，界面什么都不用说
            if (picked.canceled || picked.filePaths.length === 0) {
                return listSamples(sampleStore);
            }

            return addSample(sampleStore, picked.filePaths[0]!);
        }
    );

    ipcMain.handle(
        VOICE_CHANNELS.sampleRemove,
        async (_event, id: string): Promise<VoiceSample[]> =>
            removeSample(sampleStore, id)
    );

    ipcMain.handle(VOICE_CHANNELS.sampleRead, async (_event, id: string) =>
        readSample(sampleStore, id)
    );

    /**
     * 本地复刻引擎在不在。
     *
     * **每次问都真探一遍**，不缓存：用户很可能是看到"连不上"之后才去把
     * IndexTTS2 启起来，然后回来重试。缓存住的话他会以为自己白启了。
     */
    ipcMain.handle(
        VOICE_CHANNELS.sampleEngine,
        async (): Promise<VoiceEngineStatus> => checkIndexTts()
    );

    ipcMain.handle(
        PROJECT_CHANNELS.list,
        async (): Promise<ProjectSummary[]> => listProjects(paths.projectsRoot)
    );

    ipcMain.handle(PROJECT_CHANNELS.load, async (_event, dirName: string) => {
        // 目录名同样当不可信输入，越界校验在 project-store 里
        const project = await readProject(paths.projectsRoot, dirName);
        // 不再需要登记素材路径：预览走的是 `miaoma-media://project/<目录>/…`，
        // 主进程自己按工程 JSON 翻译 id，渲染层根本拿不到路径
        return project;
    });

    ipcMain.handle(
        PROJECT_CHANNELS.request,
        async (
            _event,
            dirName: string,
            request: { sceneId: string | null; text: string }
        ) =>
            // 目录名当不可信输入，越界校验在 project-store 里
            appendRequest(paths.projectsRoot, dirName, request)
    );

    /**
     * 按一句要求把某一镜真的重做一遍。
     *
     * 和上面那条 `request` 的分工：那条只是**记下来**（针对整条片子的要求
     * 暂时只能这样），这条是**真改**。两条都留着，因为"记一笔回头再说"
     * 和"现在就改"是用户真实会有的两种意图。
     *
     * 合成走**同一个分流入口**：这一镜原来用的是自定义音色，改完还得是它。
     */
    ipcMain.handle(
        PROJECT_CHANNELS.refineScene,
        async (
            _event,
            dirName: string,
            sceneId: string,
            instruction: string,
            speed?: number
        ): Promise<VideoProject> =>
            refineScene({
                root: paths.projectsRoot,
                dirName,
                sceneId,
                instruction,
                audioDir: paths.audioDir,
                // 缺凭证时要把找过的位置列出来，否则"放了却读不到"只能靠猜
                envSearchPaths: paths.envSearchPaths ?? [],
                // 合成器单独一个函数，不在这里现写闭包——
                // 写在这儿的话它一条测试都覆盖不到，而语速、参考音频
                // 这类"漏传一个参数"的错恰好都住在这种地方
                synthesize: makeSceneSynthesizer({
                    referenceOf,
                    ...(speed === undefined ? {} : { speed }),
                    cache: ttsCache()
                }),
                onProgress: (stage: RefineStage) => {
                    const win = getWindow();
                    if (win && !win.isDestroyed()) {
                        win.webContents.send(
                            PROJECT_CHANNELS.refineEvent,
                            stage
                        );
                    }
                }
            })
    );

    ipcMain.handle(
        PROJECT_CHANNELS.subtitleStyle,
        async (
            _event,
            dirName: string,
            styleId: string,
            style: SubtitleStyle
        ) =>
            // 目录名与样式 id 都当不可信输入，校验在 project-store 里；
            // 样式本身由 saveProject 写前过一遍 schema
            saveSubtitleStyle(paths.projectsRoot, dirName, styleId, style)
    );

    ipcMain.handle(
        PROJECT_CHANNELS.voiceGain,
        async (_event, dirName: string, gainDb: number) =>
            // 目录名与音量都当不可信输入，校验在 project-store 里
            saveVoiceGain(paths.projectsRoot, dirName, gainDb)
    );

    ipcMain.handle(
        PROJECT_CHANNELS.save,
        async (_event, dirName: string, project: VideoProject) =>
            // 目录名当不可信输入；工程本身在 project-store 里过一遍九条不变量
            saveWholeProject(paths.projectsRoot, dirName, project)
    );

    /**
     * 渲染导出。
     *
     * **保存位置由主进程问**：渲染层不碰路径，这和媒体协议是同一条规矩。
     * 用户点取消时返回 `cancelled` 而不是抛错——取消不是故障。
     */
    ipcMain.handle(
        PROJECT_CHANNELS.export,
        async (_event, dirName: string): Promise<ExportResult> => {
            const win = getWindow();
            if (!win) return { status: 'cancelled' };

            const picked = await dialog.showSaveDialog(win, {
                title: '导出成片',
                defaultPath: `${dirName}.mp4`,
                filters: [{ name: '视频', extensions: ['mp4'] }],
                buttonLabel: '导出到这里'
            });
            if (picked.canceled || !picked.filePath) {
                return { status: 'cancelled' };
            }

            const outPath = await exportVideo({
                root: paths.projectsRoot,
                dirName,
                outPath: picked.filePath,
                onProgress: (progress: ExportProgressEvent) => {
                    const target = getWindow();
                    if (target && !target.isDestroyed()) {
                        target.webContents.send(
                            PROJECT_CHANNELS.exportEvent,
                            progress
                        );
                    }
                }
            });

            return { status: 'done', outPath };
        }
    );

    ipcMain.handle(PROJECT_CHANNELS.remove, async (_event, dirName: string) => {
        // 目录名来自渲染层，**一律当不可信输入**——
        // 越界校验在 project-store 里
        await removeProject(paths.projectsRoot, dirName);
    });

    return runner;
}

export { messageOf };
