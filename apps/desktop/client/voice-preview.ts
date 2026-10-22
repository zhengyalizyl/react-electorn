import { readFile } from 'node:fs/promises';
import path from 'node:path';

import {
    isUsableVoiceId,
    makeVoiceProvider
} from '@magicut-react-demo/video-agent';

import type { VoicePreview } from './agent-ipc';

/**
 * 试听：用某个音色真合成一小段，发回渲染层去播。
 *
 * ## 为什么发字节而不是路径
 *
 * **渲染层拿不到也不该拿到本地路径**（整个媒体链路都是这个原则：
 * 渲染层只说 id，由主进程翻译成文件）。工程里的素材走自定义协议，
 * 但试听的样本不属于任何工程，没有 id 可说。
 *
 * 一段几秒的 mp3 是几十 KB，走一次 IPC 完全无所谓，
 * 而为它单开一条协议路径要维护生命周期、清理、越权校验——不值当。
 *
 * ## 为什么样本文案是固定的
 *
 * 试听要回答的是「这个音色听起来是什么样」，不是「这条片子念出来什么样」。
 * 拿当前文稿去念的话，换个音色就要重新合成一遍整段，又慢又费钱，
 * 而用户想听的其实只是音色本身。
 */

/** 试听用的样本。短、有起伏、能听出音色特点 */
export const SAMPLE_TEXT = '你好，这是我的声音。接下来由我为你讲述这条片子。';

/** 扩展名 → mime。合成出来的是 mp3 还是 wav 取决于 provider 与配置 */
const MIME: Record<string, string> = {
    '.mp3': 'audio/mpeg',
    '.wav': 'audio/wav',
    '.pcm': 'audio/wave'
};

export async function synthesizeVoicePreview(options: {
    voiceId: string;
    outDir: string;
    env?: Record<string, string | undefined>;
    /** 自定义音色的参考音频在哪。不传就是只能试听官方音色 */
    referenceOf?: (sampleId: string) => Promise<string | null>;
    /**
     * 语速倍率。只有本地引擎支持——官方音色那条传了也是白传。
     *
     * 试听要按它来：界面上拖到 1.4x 再点试听，听到的还是原速的话，
     * 用户没法判断这个滑杆到底有没有用。
     */
    speed?: number;
}): Promise<VoicePreview> {
    /**
     * **渲染层给的音色 id 不可信**：不认识就直接拒，
     * 而不是把它原样发给合成服务（那边只会返回一个看不懂的错误）。
     * 这和 `StartRunInput.voiceId` 是同一条规矩。
     *
     * 白名单同时放行官方目录与自定义音色前缀——走哪个引擎由
     * `makeVoiceProvider` 分流，这里只管"认不认得"。
     */
    if (!isUsableVoiceId(options.voiceId)) {
        throw new Error(`不认识的音色：${options.voiceId}`);
    }

    const tts = makeVoiceProvider({
        outDir: options.outDir,
        voiceId: options.voiceId,
        ...(options.env ? { env: options.env } : {}),
        ...(options.referenceOf ? { referenceOf: options.referenceOf } : {}),
        ...(options.speed === undefined ? {} : { speed: options.speed })
    });

    const result = await tts.synthesize({
        text: SAMPLE_TEXT,
        voiceId: options.voiceId,
        // 按音色分文件：换音色要重新合成，同一个音色第二次点就命中磁盘上那份
        /**
         * 文件名带上语速。
         *
         * **不是为了缓存**——这一层没有缓存，三个 provider 都是无条件
         * 合成再写盘。作用是让不同语速的产物落在不同文件上：
         * 共用一个名字的话，两次试听叠在一起时后写的会盖掉先写的，
         * 而先那次可能正要去读它。
         */
        scriptHash: `preview-${options.voiceId}-${options.speed ?? 1}`
    });

    const audio = await readFile(result.path);
    const mime = MIME[path.extname(result.path).toLowerCase()] ?? 'audio/mpeg';

    return {
        dataUrl: `data:${mime};base64,${audio.toString('base64')}`,
        durationMs: result.durationMs,
        // mock 产出的是**长度正确的静音**。界面要说清楚，
        // 否则用户点了试听什么也没听见，只会以为播放坏了
        provider: result.provider.name
    };
}
