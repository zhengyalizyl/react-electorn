/**
 * TTS provider 的对外接缝（B6b）。
 *
 * 与 LLM provider 同样的用意：图节点只认这个接口。
 *
 * 接口背后现在有三个实现：火山语音（官方音色，HTTP 端点）、本地 IndexTTS2
 * （自定义音色，零样本克隆）、Mock（无凭证时跑通管线，产出长度正确的静音）。
 * 选哪个由 `router.ts` 按音色分流，节点一律不关心。
 */

/**
 * 词级时间戳。
 *
 * **火山不返回**（plan.md §4.1，已确认）：`words` 与 `phonemes` 都是空数组，
 * `enable_timestamp` 的几种写法也无效。字段保留为可选，是为了换 provider
 * 或接口哪天补上时能直接用——**当前没有任何代码依赖它存在**。
 */
export interface TtsWordTiming {
    word: string;
    startMs: number;
    endMs: number;
}

export interface TtsRequest {
    text: string;
    /** 音色。从配置读，不写死（plan.md §10） */
    voiceId: string;
    /** 用于缓存与追溯。通常是文案的 sha256 */
    scriptHash: string;
}

export interface TtsResult {
    /** 音频落盘路径 */
    path: string;
    /**
     * **实测时长**，不是估算也不是接口元数据。
     *
     * plan.md §10.1：时间线的正确性不能依赖第三方元数据。
     * 整条时间线都由它反推（§3.1），错一毫秒就全错。
     */
    durationMs: number;
    /** 有就用，没有就按字数比例分配字幕（B7 已按这个前提设计） */
    wordTimings?: readonly TtsWordTiming[];
    provider: { name: string; model: string; voiceId: string };
}

export interface TtsProvider {
    readonly name: string;
    readonly model: string;
    synthesize(request: TtsRequest): Promise<TtsResult>;
}

export class TtsProviderError extends Error {
    readonly scriptHash: string;
    override readonly cause?: unknown;

    constructor(scriptHash: string, message: string, cause?: unknown) {
        super(message);
        this.name = 'TtsProviderError';
        this.scriptHash = scriptHash;
        this.cause = cause;
    }
}
