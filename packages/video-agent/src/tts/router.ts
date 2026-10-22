import type { TtsCacheStore } from './cache-store';
import { isIndexTtsVoice } from './custom-voices';
import { makeTtsProvider } from './factory';
import { IndexTtsProvider } from './index-tts';
import type { TtsProvider } from './types';
import { isKnownVoice } from './voices';

/**
 * 按音色标识分流到对应的合成服务。
 *
 * ## 为什么必须只有这一个入口
 *
 * 用到合成的有三条路：创作时生成口播、试听、整条片子重配。各自判一次
 * "这个音色是不是自定义的"，迟早有一条忘了改——表现是「试听自己的音色
 * 能出声，点生成却变回官方音色」这种查起来极费劲的不一致。
 *
 * ## 缺哪一边都要到用到时才报错
 *
 * 只用官方音色的用户没装 IndexTTS2 是常态，不该因此连合成入口都建不起来；
 * 反过来也一样。所以这里不在构造时拒绝，而是在真要用到那一边时才说
 * **具体缺什么、怎么补**。
 */

/** 本地引擎的服务地址从哪读。**不给默认值**，理由见 index-tts.ts */
export const INDEX_TTS_URL_ENV = 'INDEX_TTS_URL';

/**
 * 读本地引擎地址。没配、或配得不像个 http 地址都返回 null。
 *
 * 拦住非 http 的值是因为：一个写错的地址（比如漏了协议头）会让 fetch
 * 抛一句 "Failed to parse URL"，而那句话不会让任何人想到去看环境变量。
 */
export function indexTtsEndpoint(
    env: Record<string, string | undefined> = process.env
): string | null {
    const value = (env[INDEX_TTS_URL_ENV] ?? '').trim();
    return /^https?:\/\//.test(value) ? value : null;
}

/**
 * 这个音色 id 是我们认得的吗。
 *
 * **渲染层给的音色 id 不可信**：不认识就直接拒，而不是把它原样发给合成
 * 服务（那边只会返回一个看不懂的错误）。官方音色对着目录查，
 * 自定义音色认前缀——参考音频还在不在由音色库那一侧回答。
 */
export function isUsableVoiceId(voiceId: string): boolean {
    return isKnownVoice(voiceId) || isIndexTtsVoice(voiceId);
}

export interface VoiceProviderOptions {
    /** 音频落盘目录 */
    outDir: string;
    voiceId: string;
    env?: Record<string, string | undefined>;
    /**
     * 自定义音色的参考音频在哪。不传就是没接音色库——
     * 此时选了自定义音色会在这里被拦下，而不是走到 fetch 才失败。
     */
    referenceOf?: (sampleId: string) => Promise<string | null>;
    /** 语速倍率，目前只有本地引擎支持 */
    speed?: number;
    /**
     * 语音缓存元数据库。**可选**——不给就退回只看文件在不在。
     * 两条引擎共用同一个库：同一段文案换个引擎本来就是另一份音频，
     * 键里带了音色与语速，不会串。
     */
    cache?: TtsCacheStore;
}

export function makeVoiceProvider(options: VoiceProviderOptions): TtsProvider {
    const env = options.env ?? process.env;

    if (!isIndexTtsVoice(options.voiceId)) {
        return makeTtsProvider({
            outDir: options.outDir,
            voiceId: options.voiceId,
            ...(options.env ? { env: options.env } : {}),
            ...(options.cache ? { cache: options.cache } : {})
        });
    }

    const endpoint = indexTtsEndpoint(env);
    if (endpoint === null) {
        throw new Error(
            `自定义音色要本地 IndexTTS2 才能合成，但还没配 ${INDEX_TTS_URL_ENV}（形如 http://127.0.0.1:7860）`
        );
    }
    if (options.referenceOf === undefined) {
        throw new Error('没有接上自定义音色库，取不到参考音频');
    }

    return new IndexTtsProvider({
        endpoint,
        outDir: options.outDir,
        referenceOf: options.referenceOf,
        ...(options.speed === undefined ? {} : { speed: options.speed }),
        ...(options.cache ? { cache: options.cache } : {})
    });
}

/** 本地引擎现在能不能用。`reason` 在可用时是 null */
export interface IndexTtsStatus {
    ready: boolean;
    reason: string | null;
}

/**
 * 探一次本地引擎。
 *
 * 界面要据此说话：**"没配置"和"连不上"是两件事，要补的东西完全不同**。
 * 合成一个笼统的"不可用"，用户只能去猜。
 */
export async function checkIndexTts(
    options: {
        env?: Record<string, string | undefined>;
        fetchImpl?: typeof fetch;
        timeoutMs?: number;
    } = {}
): Promise<IndexTtsStatus> {
    const endpoint = indexTtsEndpoint(options.env ?? process.env);

    if (endpoint === null) {
        return {
            ready: false,
            reason: `还没配 ${INDEX_TTS_URL_ENV}（形如 http://127.0.0.1:7860），自定义音色合成不了`
        };
    }

    const provider = new IndexTtsProvider({
        endpoint,
        outDir: '',
        referenceOf: async () => null,
        ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
        // 探活不该让界面等两分钟：连不上就是连不上，几秒内就有结论
        timeoutMs: options.timeoutMs ?? 3_000
    });

    return (await provider.health())
        ? { ready: true, reason: null }
        : {
              ready: false,
              reason: `连不上本地 IndexTTS2（${endpoint}），自定义音色暂时合成不了`
          };
}
