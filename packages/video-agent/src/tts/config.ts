import { z } from 'zod';

import { isKnownVoice, VOICE_CATALOG } from './voices';

/**
 * TTS 配置（plan.md §10）。
 *
 * 端点、模型、音色、输出格式**一处都不写死**，全部从环境变量读。
 * 凭证只在主进程读取，绝不进渲染进程。
 */

export class TtsConfigError extends Error {
    readonly issues: readonly string[];

    constructor(issues: readonly string[]) {
        super(`TTS 配置不可用：${issues.join('；')}`);
        this.name = 'TtsConfigError';
        this.issues = issues;
    }
}

export const ttsConfigSchema = z.object({
    provider: z.enum(['volcano', 'mock']).default('mock'),
    /**
     * 合成端点。
     *
     * **用 HTTP 而不是官方示例里的 WebSocket**：那条路要一层没给源码的
     * 二进制分帧协议（plan.md 待决 #2）。实测这个 HTTP 端点用同一把 key
     * 就能返回可播的 mp3，于是那道阻塞就绕开了。
     */
    url: z.string().url(),
    apiKey: z.string().min(1),
    /** `X-Api-Resource-Id` 传的就是模型名——不是另一个独立的资源 ID（§4.1） */
    model: z.string().min(1),
    voiceId: z.string().min(1),
    audioFormat: z.enum(['mp3', 'pcm', 'wav']).default('mp3'),
    sampleRate: z.int().positive().default(24_000),
    /** 音频落盘目录 */
    outDir: z.string().min(1)
});

export type TtsConfig = z.infer<typeof ttsConfigSchema>;

const VOLCANO_DEFAULT_MODEL = 'seed-tts-2.0';

const VOLCANO_DEFAULT_URL =
    'https://openspeech.bytedance.com/api/v3/plan/tts/unidirectional';

const MOCK_DEFAULTS = {
    url: 'https://mock.invalid/tts',
    apiKey: 'mock',
    model: 'mock-tts'
} as const;

/** 环境变量里的空串等同于没配 */
function nonEmpty(value: string | undefined): string | undefined {
    return value === undefined || value === '' ? undefined : value;
}

/**
 * 没写 `TTS_PROVIDER` 时用哪个。
 *
 * **有凭证就合成真配音。** 以前一律退回 Mock，于是配好了 key 的人打开界面
 * 还是一片静音，只能以为播放器坏了——而"再加一行 TTS_PROVIDER=volcano"
 * 这件事，没读过这份代码的人不可能猜到。
 *
 * Mock 留给没凭证的场合（测试、离线跑通管线）：它生成的是**长度正确的静音**，
 * 时间轴照样对，只是听不见。
 */
function defaultProvider(
    env: Record<string, string | undefined>
): 'volcano' | 'mock' {
    const key = nonEmpty(env['TTS_API_KEY']) ?? nonEmpty(env['ARK_API_KEY']);
    return key === undefined ? 'mock' : 'volcano';
}

export function loadTtsConfig(
    env: Record<string, string | undefined> = process.env,
    defaults: { outDir: string; voiceId: string }
): TtsConfig {
    const provider = env['TTS_PROVIDER'] ?? defaultProvider(env);
    const isMock = provider === 'mock';

    const raw = {
        provider,
        url:
            env['TTS_URL'] ??
            (isMock ? MOCK_DEFAULTS.url : VOLCANO_DEFAULT_URL),
        // 实测方舟的 key 就能用在这个端点上；单独给一个变量是为了
        // 哪天语音换成独立凭证时不用改代码
        // 空串当没配：`ARK_API_KEY=` 这种写法很常见，
        // 让它一路走到 zod 只会换来一句「apiKey：Too small」
        apiKey:
            nonEmpty(env['TTS_API_KEY']) ??
            nonEmpty(env['ARK_API_KEY']) ??
            (isMock ? MOCK_DEFAULTS.apiKey : undefined),
        // 火山这一侧的默认模型就是 seed-tts-2.0（§4.1 已坐实）。
        // 不给默认值的话，配了 provider 却没配模型会以一句
        // 「model：expected string」告吹——那句话对用户毫无帮助
        model:
            env['TTS_MODEL'] ??
            (isMock ? MOCK_DEFAULTS.model : VOLCANO_DEFAULT_MODEL),
        voiceId: env['TTS_VOICE'] ?? defaults.voiceId,
        audioFormat: env['TTS_AUDIO_FORMAT'],
        sampleRate: env['TTS_SAMPLE_RATE']
            ? Number(env['TTS_SAMPLE_RATE'])
            : undefined,
        outDir: env['TTS_OUT_DIR'] ?? defaults.outDir
    };
    const cleaned = Object.fromEntries(
        Object.entries(raw).filter(([, value]) => value !== undefined)
    );

    const parsed = ttsConfigSchema.safeParse(cleaned);
    if (!parsed.success) {
        throw new TtsConfigError(
            parsed.error.issues.map(
                (issue) => `${issue.path.join('.') || '(根)'}：${issue.message}`
            )
        );
    }

    /**
     * 音色白名单校验。
     *
     * **只对真 provider 生效**——Mock 不发请求，随便填什么都不会炸，
     * 拦着它反而挡住"没凭证也能跑通"这条底线（tasks.md 的 P1 前提）。
     *
     * 对真 provider 则必须拦：配了一个不存在的音色，不校验的话要等到
     * 第一次合成配音才收到一个看不懂的服务端错误，而那时用户已经等了半分钟。
     */
    if (parsed.data.provider !== 'mock' && !isKnownVoice(parsed.data.voiceId)) {
        throw new TtsConfigError([
            `音色 ${parsed.data.voiceId} 不在目录里。` +
                `可用的有 ${VOICE_CATALOG.length} 个，例如 ${VOICE_CATALOG.slice(
                    0,
                    3
                )
                    .map((v) => `${v.id}（${v.name}）`)
                    .join('、')}`
        ]);
    }

    return parsed.data;
}
