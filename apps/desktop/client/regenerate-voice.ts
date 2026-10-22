import { createHash } from 'node:crypto';
import path from 'node:path';

import {
    isUsableVoiceId,
    makeVoiceProvider
} from '@magicut-react-demo/video-agent';
import type {
    Asset,
    AssetId,
    VideoProject
} from '@magicut-react-demo/video-project';
import {
    relayoutBlockedReason,
    relayoutFromVoiceDurations,
    validateProject
} from '@magicut-react-demo/video-project';
import {
    loadProject,
    saveProject
} from '@magicut-react-demo/video-project/node';

import { PROJECT_FILE } from './project-store';

/**
 * 用指定音色把整条片子的口播重新合成一遍，并按新时长重排时间线。
 *
 * ## 为什么必须连着重排一起做
 *
 * 时间轴是**由配音驱动**的：分镜长度就是该镜配音的时长。换个音色，
 * 每一镜的长度都会变——只换音频不重排的话，工程立刻就非法了
 * （分镜时长与配音对不上、分镜之间出现缝、画布总时长不符）。
 *
 * 所以这两件事不能分开暴露成两个接口：**中间那个状态是不合法的**，
 * 任何一步失败都不该把它留在盘上。
 *
 * ## 失败就整体不动
 *
 * 九镜里合成到第七镜断网了，那前六镜的新音频已经在盘上——但**工程文件一个字
 * 都不改**。用户看到的是"生成失败"，片子还是原来那条，而不是前六镜换了音色、
 * 后三镜没换的那种半成品（那种状态他既看不出来，也没法修）。
 */

export interface RegenerateProgress {
    done: number;
    total: number;
    /** 当前这一镜的文案开头，给进度条当标签用 */
    label: string;
}

export interface RegenerateOptions {
    root: string;
    dirName: string;
    voiceId: string;
    audioDir: string;
    onProgress?: ((progress: RegenerateProgress) => void) | undefined;
    env?: Record<string, string | undefined>;
    /** 自定义音色的参考音频在哪。不传就是只能用官方音色重配 */
    referenceOf?: ((sampleId: string) => Promise<string | null>) | undefined;
    /**
     * 语速倍率。
     *
     * **只有本地引擎支持**：火山那条合成接口没有这个参数，传了也是白传。
     * 所以界面上要分清楚——用自己的音色重新生成才真的变速，
     * 官方音色那条只有预览在变。
     *
     * 变速会让每一镜的长度全变，而那正是 `relayoutFromVoiceDurations`
     * 要干的事：时长按**实测**重排，所以这里不用管时间轴。
     */
    speed?: number | undefined;
}

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

function hashOf(text: string, voiceId: string): string {
    return createHash('sha256')
        .update(`${voiceId}:${text}`)
        .digest('hex')
        .slice(0, 32);
}

export async function regenerateVoice(
    options: RegenerateOptions
): Promise<VideoProject> {
    assertSafeDirName(options.dirName);

    /**
     * **渲染层给的音色 id 不可信**：不认识就直接拒，
     * 而不是把它原样发给合成服务（那边只会返回一个看不懂的错误）。
     *
     * 白名单同时放行官方目录与自定义音色前缀——走哪个引擎由
     * `makeVoiceProvider` 分流，这里只管"认不认得"。
     */
    if (!isUsableVoiceId(options.voiceId)) {
        throw new Error(`不认识的音色：${options.voiceId}`);
    }

    const file = path.join(options.root, options.dirName, PROJECT_FILE);
    const { project } = await loadProject(file);

    // 先问能不能做。做不了的理由要在**一次合成都还没发生**时就说出来——
    // 合成是按量计费的，不该先花钱再发现结果用不上
    const blocked = relayoutBlockedReason(project);
    if (blocked) throw new Error(blocked);

    /**
     * provider 在**第一镜开合成之前**就建好。
     *
     * 自定义音色缺配置（没写 `INDEX_TTS_URL`）会在这一步抛，
     * 而这时一次合成都还没发生——和上面那条"做不了的理由要早说"同一个道理。
     */
    const tts = makeVoiceProvider({
        outDir: options.audioDir,
        voiceId: options.voiceId,
        ...(options.env ? { env: options.env } : {}),
        ...(options.referenceOf ? { referenceOf: options.referenceOf } : {}),
        ...(options.speed === undefined ? {} : { speed: options.speed })
    });

    // 资产表的键是 branded 的 AssetId，拿普通 string 当索引编译不过。
    // 先在一张普通表上攒，最后一次性接回去
    const assets: Record<string, Asset> = { ...project.assets };
    const updates = [];

    for (const [index, scene] of project.scenes.entries()) {
        options.onProgress?.({
            done: index,
            total: project.scenes.length,
            label: scene.script.slice(0, 20)
        });

        const scriptHash = `sha256:${hashOf(scene.script, options.voiceId)}`;
        const result = await tts.synthesize({
            text: scene.script,
            voiceId: options.voiceId,
            scriptHash
        });

        // 每镜一个新资产 id：沿用旧 id 的话，万一中途失败，
        // 盘上的旧工程会指向一个已经被覆盖的文件
        const assetId = `asset_a_${hashOf(scene.id, options.voiceId).slice(
            0,
            8
        )}`;
        assets[assetId] = {
            kind: 'audio',
            path: path.relative(path.dirname(file), result.path),
            absolutePath: result.path,
            hash: scriptHash,
            durationMs: result.durationMs
        };

        updates.push({
            sceneId: scene.id,
            durationMs: result.durationMs,
            assetId,
            provider: {
                name: tts.name,
                model: tts.model,
                voiceId: options.voiceId
            }
        });
    }

    options.onProgress?.({
        done: project.scenes.length,
        total: project.scenes.length,
        label: '重排时间线'
    });

    const next = relayoutFromVoiceDurations(
        { ...project, assets: assets as VideoProject['assets'] },
        updates.map((item) => ({ ...item, assetId: item.assetId as AssetId }))
    );

    /**
     * 落盘前再过一遍九条不变量。
     *
     * `saveProject` 只查结构，查不出"分镜之间有缝"这类语义错乱——
     * 而那种工程写下去之后界面照画、播放照播，只有导出那天才会炸。
     */
    const issues = validateProject(next);
    if (issues.length > 0) {
        throw new Error(
            `重排后的工程不合法，已放弃本次生成：${issues
                .map((issue) => issue.message)
                .join('；')}`
        );
    }

    await saveProject(file, next);
    return next;
}
