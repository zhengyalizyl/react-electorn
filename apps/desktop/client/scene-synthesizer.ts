import type { TtsCacheStore } from '@magicut-react-demo/video-agent';
import { makeVoiceProvider } from '@magicut-react-demo/video-agent';

/**
 * 「改一镜」那条路要用的合成器。
 *
 * ## 为什么要把它从 ipc.ts 里拎出来
 *
 * `refineScene` 把合成**注入**进去（选哪个引擎取决于这一镜原来用的音色，
 * 而参考音频在音色库里，那是 ipc 层才知道的事）。注入是对的，但代价是：
 * **真正建合成器的那段代码一条测试都覆盖不到**——`refine-scene` 的测试全都
 * 传的是假 synthesize。
 *
 * 而那正是最容易写错的地方。语速漏传就住在这里：改完一镜会按 1.0x 合成，
 * 而左右两镜是按 1.4x 重新生成过的，那一镜忽然变慢，界面上没有任何提示。
 * 同一类的还有参考音频漏传——改完之后换成了一个不认识的声音。
 *
 * 搬到这里之后它是个普通函数，能直接测；`ipc.ts` 只负责把音色库和当前语速
 * 递进来。**`ipc.ts` 哪天不再用它，是一处看得见的改动**，而不是悄悄飘走。
 */

export interface SceneSynthesizerOptions {
    /**
     * 自定义音色的参考音频在哪。不传就是没接音色库——
     * 此时选了自定义音色会在分流那一层被拦下，而不是走到合成请求才失败。
     */
    referenceOf?: ((sampleId: string) => Promise<string | null>) | undefined;
    /**
     * 语速倍率。**跟着整条片子走**，不是每镜各自一个值。
     *
     * 只有本地引擎认：火山那条合成接口没有这个参数，传了也是白传。
     */
    speed?: number | undefined;
    env?: Record<string, string | undefined> | undefined;
    /**
     * 语音缓存元数据库。
     *
     * **同一段文案 + 同一个音色 + 同样参数，合成出来完全一致**——
     * 改一镜文案要重跑整条链、重开一次应用、repair 走第二遍，
     * 其中绝大多数分镜一个字都没动，重合成纯属白花钱。
     */
    cache?: TtsCacheStore | undefined;
}

export interface SceneSynthesisInput {
    text: string;
    voiceId: string;
    scriptHash: string;
    outDir: string;
}

export interface SceneSynthesisResult {
    path: string;
    durationMs: number;
    provider: { name: string; model: string; voiceId: string };
}

export function makeSceneSynthesizer(
    options: SceneSynthesizerOptions = {}
): (input: SceneSynthesisInput) => Promise<SceneSynthesisResult> {
    return async (input) => {
        /**
         * **每次调用现建一个 provider**，不在外面建好复用。
         *
         * 音色是按镜取的（`refineScene` 沿用这一镜原来那个），
         * 而 `makeVoiceProvider` 要靠音色来决定走哪个引擎。
         * 提前建好就只能锁死一个音色，改到自定义音色那镜时会发错地方。
         */
        const tts = makeVoiceProvider({
            outDir: input.outDir,
            voiceId: input.voiceId,
            ...(options.referenceOf
                ? { referenceOf: options.referenceOf }
                : {}),
            ...(options.speed === undefined ? {} : { speed: options.speed }),
            ...(options.env ? { env: options.env } : {}),
            ...(options.cache ? { cache: options.cache } : {})
        });

        return tts.synthesize({
            text: input.text,
            voiceId: input.voiceId,
            scriptHash: input.scriptHash
        });
    };
}
