import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

import type { TtsProvider, TtsRequest, TtsResult } from './types';

/**
 * 无凭证、无网络的 TTS。
 *
 * **不是玩具。** P1 的全部验收都靠它跑（tasks.md 阶段划分：「TTS 用 Mock」），
 * 所以它必须做对两件事：
 *
 * 1. **时长分布接近真人语速**——排出来的时间线才有意义。
 *    时长估错，整条时间线就全错（§3.1 时间轴由音频驱动）
 * 2. **产出真实可读的 WAV 文件**——下游 ffprobe 量时长时能量到，
 *    而不是在 P3 才发现"原来 Mock 写的是空文件"
 */

/**
 * 中文口播语速。
 *
 * 4.5 字/秒 ≈ 270 字/分钟，是新闻播报到日常口播的常见区间。
 * 真人会更慢一些，但 Mock 的目的是让时间线"像那么回事"，不是复刻某个人。
 */
const CHARS_PER_SECOND = 4.5;
/** 半角字符按半个中文字算——英文单词读起来比汉字快 */
const HALF_WIDTH_WEIGHT = 0.5;
/** 每句话前后的自然停顿 */
const PADDING_MS = 300;
/** 再短的句子也得有这么长，否则会切出零长 clip */
const MIN_DURATION_MS = 500;

const SAMPLE_RATE = 24_000;
const CHANNELS = 1;
const BITS_PER_SAMPLE = 16;

function isFullWidth(codePoint: number): boolean {
    return (
        (codePoint >= 0x2e80 && codePoint <= 0xa4cf) ||
        (codePoint >= 0xac00 && codePoint <= 0xd7a3) ||
        (codePoint >= 0xf900 && codePoint <= 0xfaff) ||
        (codePoint >= 0xfe30 && codePoint <= 0xfe6f) ||
        (codePoint >= 0xff00 && codePoint <= 0xff60)
    );
}

/**
 * 按字数估时长。**纯函数**，单独可测——这是 Mock 唯一有实质内容的部分。
 *
 * 标点不计入朗读时长，但会贡献停顿，所以统一折进 `PADDING_MS`，
 * 不逐个标点加时间（那样长句会被累加出离谱的长度）。
 */
export function estimateDurationMs(text: string): number {
    let weight = 0;
    for (const char of text) {
        const code = char.codePointAt(0) ?? 0;
        // 标点与空白不发声
        if (/[\s，。！？、；：,.!?;:…—"'「」（）()]/u.test(char)) continue;
        weight += isFullWidth(code) ? 1 : HALF_WIDTH_WEIGHT;
    }
    if (weight === 0) return MIN_DURATION_MS;
    return Math.max(
        MIN_DURATION_MS,
        Math.round((weight / CHARS_PER_SECOND) * 1000) + PADDING_MS
    );
}

/**
 * 生成一个**真正合法**的 16bit PCM 静音 WAV。
 *
 * 不是写个空文件了事：下游要用 ffprobe 量时长（§10.1 不信元数据），
 * 空文件会让那一步在 P2 才炸，而那时已经看不出是 Mock 的锅。
 */
export function buildSilentWav(durationMs: number): Buffer {
    const frames = Math.max(1, Math.round((durationMs / 1000) * SAMPLE_RATE));
    const blockAlign = (CHANNELS * BITS_PER_SAMPLE) / 8;
    const dataSize = frames * blockAlign;

    const header = Buffer.alloc(44);
    header.write('RIFF', 0, 'ascii');
    header.writeUInt32LE(36 + dataSize, 4);
    header.write('WAVE', 8, 'ascii');
    header.write('fmt ', 12, 'ascii');
    header.writeUInt32LE(16, 16); // fmt 块长度
    header.writeUInt16LE(1, 20); // PCM
    header.writeUInt16LE(CHANNELS, 22);
    header.writeUInt32LE(SAMPLE_RATE, 24);
    header.writeUInt32LE(SAMPLE_RATE * blockAlign, 28); // 字节率
    header.writeUInt16LE(blockAlign, 32);
    header.writeUInt16LE(BITS_PER_SAMPLE, 34);
    header.write('data', 36, 'ascii');
    header.writeUInt32LE(dataSize, 40);

    // 静音 = 全零采样
    return Buffer.concat([header, Buffer.alloc(dataSize)]);
}

export interface MockTtsOptions {
    /** 音频落盘目录 */
    outDir: string;
    /** 覆盖时长估算，用于测试特定时长 */
    estimate?: (text: string) => number;
}

export class MockTtsProvider implements TtsProvider {
    readonly name = 'mock';
    readonly model = 'mock-tts';

    private readonly outDir: string;
    private readonly estimate: (text: string) => number;

    /** 收到过的请求，供测试断言 */
    readonly calls: TtsRequest[] = [];

    constructor(options: MockTtsOptions) {
        this.outDir = options.outDir;
        this.estimate = options.estimate ?? estimateDurationMs;
    }

    async synthesize(request: TtsRequest): Promise<TtsResult> {
        this.calls.push(request);
        const durationMs = this.estimate(request.text);

        await mkdir(this.outDir, { recursive: true });
        // 文件名用 scriptHash：同一段文案永远落到同一个文件，
        // 这正是 §6.2 增量失效想要的性质
        const file = path.join(this.outDir, `${request.scriptHash}.wav`);
        await writeFile(file, buildSilentWav(durationMs));

        return {
            path: file,
            durationMs,
            // **刻意不返回 wordTimings**：真 TTS 是否返回还没确认（待决 #3），
            // Mock 假装有的话，B7 那条"没有时间戳"的分支就永远跑不到
            provider: {
                name: this.name,
                model: this.model,
                voiceId: request.voiceId
            }
        };
    }
}
