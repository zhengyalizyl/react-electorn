import { createHash } from 'node:crypto';
import path from 'node:path';

import {
    applySceneScript,
    buildSceneRefinePrompt,
    // 和下面那些值合在一条 import 里：同一个模块拆成 `import type` + `import`
    // 两条时，eslint 的 `no-undef` 看不见类型那条的绑定，会误报未定义
    type ModelProvider,
    relayoutSceneSubtitles,
    SceneRefineSchema,
    sceneVoiceUpdates,
    voiceScriptHash
} from '@magicut-react-demo/video-agent';
import type {
    Asset,
    AssetId,
    VideoProject
} from '@magicut-react-demo/video-project';
import {
    relayoutFromVoiceDurations,
    validateProject
} from '@magicut-react-demo/video-project';
import {
    loadProject,
    saveProject
} from '@magicut-react-demo/video-project/node';

import { resolveModelProvider } from './agent-runner';
import { PROJECT_FILE } from './project-store';

/**
 * 按一句要求把某一镜**重做一遍**：文案重写、口播重配、字幕重铺、时间轴重排。
 *
 * 编辑器「快捷调整」那个输入框走的就是它。在此之前那个框只把要求记进
 * `ai.requests`——它从不声称改过片子（那一点是诚实的），但用户写完一句话
 * 看到「已记下 1 条」之后，什么也不会发生。
 *
 * ## 和「重新生成口播」的分工
 *
 * `regenerate-voice.ts` 是**换声音不改字**：整条片子全部重念。
 * 这里是**改字再重念**，而且**只念改过的那一镜**——别的镜一个字都没变，
 * 重念一遍纯属白花钱。
 *
 * 但时间轴**整条重排**：文案一变这一镜就变长变短，后面每一镜的起止都要挪。
 *
 * ## 失败就整体不动
 *
 * 模型写崩了、TTS 断了、重排之后校验不过——**工程文件一个字都不改**。
 * 用户看到的是"改失败了"，片子还是原来那条，而不是文案换了、音频没换的
 * 那种半成品（那种状态他既看不出来，也没法修）。
 */

export interface RefineSceneOptions {
    root: string;
    dirName: string;
    sceneId: string;
    /** 用户写的那句要求 */
    instruction: string;
    audioDir: string;
    env?: Record<string, string | undefined>;
    /**
     * 怎么合成。由调用方注入，因为选哪个引擎要看这一镜原来用的音色——
     * 自定义音色得走本地 IndexTTS2，而参考音频在音色库里。
     */
    synthesize: (input: {
        text: string;
        voiceId: string;
        scriptHash: string;
        outDir: string;
    }) => Promise<{
        path: string;
        durationMs: number;
        provider: { name: string; model: string; voiceId: string };
    }>;
    onProgress?: ((stage: RefineStage) => void) | undefined;
    /**
     * 用哪个模型改写。不传就按 `.env` 的配置建一个。
     *
     * 注入口是为了能测：真路径要读凭证、发请求，而这一层真正要验的是
     * "模型交回来的东西怎么落进工程"。
     */
    model?: ModelProvider | undefined;
    /** 启动时找过的 .env 位置。缺凭证时要把它们列给用户看 */
    envSearchPaths?: readonly string[] | undefined;
}

/**
 * 进度只有三档，但**必须有**。
 *
 * 改一镜要先调模型（几秒）再合成（又几秒）。只转个圈的话，用户不知道
 * 是在想词还是在念，等上十几秒就会去点别的地方。
 */
export type RefineStage = 'rewriting' | 'synthesizing' | 'relayout';

/** 目录名里不许出现路径分隔符或 `..`——否则读写会跑到工程根之外 */
function assertSafeDirName(dirName: string): void {
    if (
        dirName.length === 0 ||
        dirName.includes('/') ||
        dirName.includes('\\') ||
        dirName === '.' ||
        dirName === '..'
    ) {
        throw new Error(`非法的工程目录名：${dirName}`);
    }
}

/**
 * 资产 id 用的短 hash。
 *
 * 分镜的 `scriptHash` **不要在这里另算**——它由 `voiceScriptHash` 统一定义，
 * 图里那条路和这里写进的是同一个字段，各算各的迟早对不上。
 */
function hashOf(text: string, voiceId: string): string {
    return createHash('sha256')
        .update(`${voiceId}:${text}`)
        .digest('hex')
        .slice(0, 32);
}

export async function refineScene(
    options: RefineSceneOptions
): Promise<VideoProject> {
    assertSafeDirName(options.dirName);

    const instruction = options.instruction.trim();
    if (instruction === '') {
        throw new Error('没写要求，不知道要改什么');
    }

    const file = path.join(options.root, options.dirName, PROJECT_FILE);
    const { project } = await loadProject(file);

    const at = project.scenes.findIndex(
        (scene) => scene.id === options.sceneId
    );
    const scene = project.scenes[at];
    if (scene === undefined) {
        throw new Error(`工程里没有 ${options.sceneId} 这一镜`);
    }

    /**
     * 这一镜现在用的音色，改完继续用它。
     *
     * **改的是文案，不是声音**——顺手换个音色的话，成片里这一镜会突然
     * 换个人在说话，而用户只是让它"说得简短点"。
     */
    const voiceTrack = project.tracks.find((track) => track.kind === 'voice');
    const voiceClip =
        voiceTrack?.kind === 'voice'
            ? voiceTrack.clips.find((clip) => clip.sceneId === options.sceneId)
            : undefined;
    const voiceId = voiceClip?.provider.voiceId;

    if (voiceId === undefined) {
        // 纯画面的那一镜没有音色可沿用。整条片子本来就只用一个音色，
        // 但"给这一镜加一句旁白"是另一个需求，不在这条路上硬撑
        throw new Error('这一镜没有口播，改文案改不了它');
    }

    const env = options.env ?? process.env;

    // 凭证不对要在**调模型之前**报出来，而且给的是能照着做的那句话。
    // 那段顺序很容易写反，收在 `resolveModelProvider` 里了
    const model =
        options.model ??
        resolveModelProvider(env, options.envSearchPaths ?? []);

    options.onProgress?.('rewriting');

    const prompt = buildSceneRefinePrompt({
        script: scene.script,
        instruction,
        index: at + 1,
        total: project.scenes.length,
        before: project.scenes[at - 1]?.script ?? '',
        after: project.scenes[at + 1]?.script ?? '',
        spanMs: scene.durationMs
    });

    const written = await model.invokeStructured({
        task: 'SceneRefine',
        schema: SceneRefineSchema,
        system: prompt.system,
        user: prompt.user
    });

    /**
     * 文案先落进工程，**再**去合成。
     *
     * 顺序反过来的话，"这一镜有几段配音"这类拒绝要等合成完才发现——
     * 而那一步是花钱的。`applySceneScript` 里那几条检查都是免费的，
     * 放在前面。
     */
    const staged = applySceneScript(
        project,
        options.sceneId,
        written.value.script
    );
    const nextScript = staged.scenes[at]!.script;

    options.onProgress?.('synthesizing');

    // 与图里那条路共用同一个定义（见 `voiceScriptHash`），不另算一份
    const scriptHash = voiceScriptHash(nextScript, voiceId);
    const result = await options.synthesize({
        text: nextScript,
        voiceId,
        scriptHash,
        outDir: options.audioDir
    });

    // 新资产一个新 id：沿用旧 id 的话，万一后面校验没过，
    // 盘上的旧工程会指向一个已经被覆盖的文件
    const assetId = `asset_a_${hashOf(options.sceneId, scriptHash).slice(0, 8)}`;
    const assets: Record<string, Asset> = {
        ...staged.assets,
        [assetId]: {
            kind: 'audio',
            path: path.relative(path.dirname(file), result.path),
            absolutePath: result.path,
            hash: scriptHash,
            durationMs: result.durationMs
        }
    };

    options.onProgress?.('relayout');

    const relaid = relayoutFromVoiceDurations(
        { ...staged, assets: assets as VideoProject['assets'] },
        sceneVoiceUpdates(staged, {
            sceneId: options.sceneId,
            durationMs: result.durationMs,
            assetId: assetId as AssetId,
            provider: result.provider
        })
    );

    // 字幕**必须在重排之后重铺**：铺它要用这一镜最终的起点与长度。
    // 少这一步的话，成片里这一镜念的是新文案、字幕显示的还是旧句子
    const next = relayoutSceneSubtitles(relaid, options.sceneId);

    /**
     * 落盘前再过一遍九条不变量。
     *
     * 这一步尤其要紧：改文案会同时动分镜文稿、配音文本、字幕三处，
     * 而「配音的字拼起来等于分镜文稿」「字幕不得越出所属分镜」这类错乱
     * 写下去之后界面照画、播放照播，只有导出那天才会炸。
     */
    const issues = validateProject(next);
    if (issues.length > 0) {
        throw new Error(
            `改完之后的工程不合法，已放弃本次修改：${issues
                .map((issue) => issue.message)
                .join('；')}`
        );
    }

    await saveProject(file, next);
    return next;
}
