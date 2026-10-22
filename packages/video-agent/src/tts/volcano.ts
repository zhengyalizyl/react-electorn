import { mkdir, writeFile } from 'node:fs/promises';

import { cachedFilePath, lookupCached, ttsCacheKey } from './cache';
import type { TtsCacheStore } from './cache-store';
import type { TtsConfig } from './config';
import { measureDurationMs } from './duration';
import type { TtsProvider, TtsRequest, TtsResult } from './types';
import { TtsProviderError } from './types';

/**
 * 火山语音（豆包）真实 provider。
 *
 * ## 为什么走 HTTP 而不是官方示例的 WebSocket
 *
 * 官方 Python 示例依赖 `protocols.py` 那层**自定义二进制分帧协议，源码没给**——
 * 这正是 plan.md 待决 #2 卡住 B6b 的原因。
 *
 * 实测（2026-09-24）：`POST /api/v3/plan/tts/unidirectional` 用同一把方舟 key，
 * 610ms 返回 23 行 NDJSON，每行 `data` 是 base64 音频分片，拼起来就是能播的 mp3
 * （36 字的文案 → 9.24 秒）。于是那道阻塞绕开了，不需要那份协议规格。
 *
 * ## 时长一律用 ffprobe 量
 *
 * 输出是 mp3——**压缩格式的字节数与时长没有线性关系**，不能按采样数算。
 * 也不拿接口返回的元数据当权威值（plan.md §10.1：时间线的正确性不能依赖第三方元数据）。
 * 整条时间线都由这个时长反推（§3.1），错一毫秒就全错。
 *
 * ## 词级时间戳：确认没有
 *
 * 响应里有 `sentence` 字段，但 `words` 与 `phonemes` 都是空数组；
 * 试过 `enable_timestamp` 的几种写法（顶层 / additions / audio_params）都没用。
 * **待决 #3 的答案是"不返回"**，所以字幕继续走按字数比例分配那条路（B7 已按这个前提设计）。
 */

interface VolcanoChunk {
    code?: number;
    message?: string;
    data?: string;
}

/**
 * 不代表失败的 code。
 *
 * `0` 是普通音频分片；**`20000000` 是结束标记**——它的 message 就是 "OK"。
 * 一开始把"非零即错"当规则，结果每次合成都在最后一帧抛错：
 * 音频其实已经全拿到了。
 */
const OK_CODES = new Set([0, 20000000]);

/** 响应是一行行 JSON（NDJSON），不是一个 JSON 数组 */
function parseChunks(raw: string, scriptHash: string): Buffer {
    const parts: Buffer[] = [];
    let failure = '';

    for (const line of raw.split('\n')) {
        const trimmed = line.trim();
        if (trimmed === '') continue;

        let chunk: VolcanoChunk;
        try {
            chunk = JSON.parse(trimmed) as VolcanoChunk;
        } catch {
            // 单独一行坏掉不代表整次失败：后面的分片可能是好的。
            // 但要记下来——全坏时得有话可说
            failure = failure === '' ? `响应里有非 JSON 行` : failure;
            continue;
        }

        if (chunk.code !== undefined && !OK_CODES.has(chunk.code)) {
            throw new TtsProviderError(
                scriptHash,
                `合成失败（code ${chunk.code}）：${chunk.message ?? '无说明'}`
            );
        }
        if (typeof chunk.data === 'string' && chunk.data !== '') {
            parts.push(Buffer.from(chunk.data, 'base64'));
        }
    }

    const audio = Buffer.concat(parts);
    if (audio.length === 0) {
        throw new TtsProviderError(
            scriptHash,
            failure === '' ? '合成返回了空音频' : failure
        );
    }
    return audio;
}

export class VolcanoTtsProvider implements TtsProvider {
    readonly name = 'volcano';
    readonly model: string;

    private readonly config: TtsConfig;
    /**
     * 缓存元数据库。**可选**——命令行与测试里常常不给，
     * 那时退回"只看文件在不在"，功能照常，只是每次命中要多起一个 ffprobe。
     */
    private readonly cache: TtsCacheStore | undefined;

    constructor(config: TtsConfig, cache?: TtsCacheStore) {
        this.config = config;
        this.model = config.model;
        this.cache = cache;
    }

    async synthesize(request: TtsRequest): Promise<TtsResult> {
        const text = request.text.trim();
        if (text === '') {
            throw new TtsProviderError(request.scriptHash, '文案是空的');
        }

        /**
         * 先查缓存。**同样的文本 + 音色 + 参数，合成出来完全一致**——
         * 重合成既花钱又慢，而重复是常态：改一镜文案要重跑整条链、
         * 重开一次应用、repair 走第二遍，其中绝大多数分镜一个字都没动。
         *
         * 键由 `ttsCacheKey` 统一算（含格式与采样率），**不再用裸 `scriptHash`
         * 当文件名**——它带着 `sha256:` 的冒号，在 Windows 上建不出这个文件。
         */
        const params = {
            scriptHash: request.scriptHash,
            voiceId: request.voiceId,
            audioFormat: this.config.audioFormat,
            sampleRate: this.config.sampleRate
        };
        const file = cachedFilePath(this.config.outDir, params);
        const cached = await lookupCached(file, params, this.cache);
        if (cached !== null) {
            return {
                path: cached.path,
                // 有元数据库就直接读时长，**连 ffprobe 都不用起**；
                // 没有库才退回去量
                durationMs:
                    cached.durationMs ??
                    (await measureDurationMs(cached.path, request.scriptHash)),
                provider: {
                    name: this.name,
                    model: this.model,
                    voiceId: request.voiceId
                }
            };
        }

        let response: Response;
        try {
            response = await fetch(this.config.url, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'X-Api-Key': this.config.apiKey,
                    // 这个头传的就是模型名，不是另一个独立的资源 ID（§4.1）
                    'X-Api-Resource-Id': this.config.model
                },
                body: JSON.stringify({
                    req_params: {
                        speaker: request.voiceId,
                        text,
                        audio_params: {
                            format: this.config.audioFormat,
                            sample_rate: this.config.sampleRate
                        }
                    }
                })
            });
        } catch (error) {
            throw new TtsProviderError(
                request.scriptHash,
                '合成请求发不出去',
                error
            );
        }

        const raw = await response.text();
        if (!response.ok) {
            // **不把响应体整个抛出去**：里面可能带回请求内容
            throw new TtsProviderError(
                request.scriptHash,
                `合成服务返回 ${response.status}`
            );
        }

        const audio = parseChunks(raw, request.scriptHash);

        await mkdir(this.config.outDir, { recursive: true });
        await writeFile(file, audio);

        const durationMs = await measureDurationMs(file, request.scriptHash);
        // 登记进缓存。时长一并记下，下次命中就不用再起 ffprobe
        this.cache?.put({
            key: ttsCacheKey(params),
            path: file,
            durationMs,
            sizeBytes: audio.byteLength
        });

        return {
            path: file,
            durationMs,
            provider: {
                name: this.name,
                model: this.model,
                voiceId: request.voiceId
            }
        };
    }
}
