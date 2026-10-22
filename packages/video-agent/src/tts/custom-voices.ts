/**
 * 自定义音色的标识命名空间。
 *
 * ## 为什么要给自定义音色一个命名空间
 *
 * 官方目录里的 id 形如 `zh_female_gaolengyujie_uranus_bigtts`——**下划线遍地都是**。
 * 拿 `custom_xxx` 这种写法拼自定义音色，肉眼分不出哪条是用户自己的，
 * 合成那一步要知道"这条该发给谁"就只能回头去查库。
 *
 * 形状定成 `custom:index-tts2:<样本 id>`：
 *
 * - **前缀独占一段**，不与官方 id 的构词法重叠，判断只看字符串本身。
 * - **引擎名写在中间**。将来接第二种本地引擎时，分流仍然只看这一段，
 *   不必回头去翻"这条音色当初是哪个引擎做的"。
 *
 * ## 这个文件是浏览器安全的
 *
 * 口播面板要据此把样本摆成可选的音色行，所以渲染层会直接 import 它。
 * 和 `voices.ts` 同样的规矩：**必须保持零 import**，加依赖前先想清楚这条。
 */

/** 自定义音色的前缀。改它等于让已有工程里的音色全部失配，别改 */
export const CUSTOM_VOICE_PREFIX = 'custom:';

/** 目前唯一的本地引擎 */
export const INDEX_TTS_ENGINE = 'index-tts2';

export interface CustomVoiceRef {
    /** 引擎名。目前只有 `index-tts2` */
    engine: string;
    /** 引擎那边认的 id。对 IndexTTS2 来说就是音色库里那条样本的 id */
    sampleId: string;
}

/**
 * 拆一个音色标识。不是自定义音色就返回 null。
 *
 * **宽进严出**：段数不对、任一段为空，都当成普通音色处理而不是抛错——
 * 一个形状怪异的 id 该走默认服务去失败，不该在分流这一层就把整条链路炸掉。
 */
export function parseCustomVoice(voiceId: string): CustomVoiceRef | null {
    if (!voiceId.startsWith(CUSTOM_VOICE_PREFIX)) {
        return null;
    }

    const [, engine = '', ...rest] = voiceId.split(':');
    const sampleId = rest.join(':');

    return engine === '' || sampleId === '' ? null : { engine, sampleId };
}

/** 这条音色要走本地 IndexTTS2 吗 */
export function isIndexTtsVoice(voiceId: string): boolean {
    return parseCustomVoice(voiceId)?.engine === INDEX_TTS_ENGINE;
}

/** 把音色库里那条样本的 id 包成工程里存的那个标识 */
export function indexTtsVoiceId(sampleId: string): string {
    return `${CUSTOM_VOICE_PREFIX}${INDEX_TTS_ENGINE}:${sampleId}`;
}
