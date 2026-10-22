import type { TtsCacheStore } from './cache-store';
import { loadTtsConfig } from './config';
import { MockTtsProvider } from './mock';
import type { TtsProvider } from './types';
import { VolcanoTtsProvider } from './volcano';

/**
 * 按配置选 TTS provider。
 *
 * 桌面端与命令行都从这里拿，**两条路不能各选各的**——
 * 之前桌面端写死了 Mock，于是命令行接通真配音之后界面上依然是静音，
 * 而那台机器上的人只会以为"播放器坏了"。
 *
 * `TTS_PROVIDER` 不写时按**有没有凭证**决定（见 config 的 defaultProvider）：
 * 有 key 就合成真配音，没有才退回 Mock。Mock 生成的是**长度正确的静音**，
 * 管线能跑通、不花钱，但听不到声音——这一点界面上要说清楚（预览里已经写了）。
 */
export function makeTtsProvider(options: {
    env?: Record<string, string | undefined>;
    outDir: string;
    voiceId: string;
    /** 语音缓存元数据库。可选——Mock 不用它（它本来就不花钱也不慢） */
    cache?: TtsCacheStore;
}): TtsProvider {
    const config = loadTtsConfig(options.env ?? process.env, {
        outDir: options.outDir,
        voiceId: options.voiceId
    });

    return config.provider === 'volcano'
        ? new VolcanoTtsProvider(config, options.cache)
        : new MockTtsProvider({ outDir: config.outDir });
}
