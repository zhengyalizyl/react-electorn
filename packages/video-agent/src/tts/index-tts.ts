import { mkdir, writeFile } from 'node:fs/promises';

import { cachedFilePath, lookupCached, ttsCacheKey } from './cache';
import type { TtsCacheStore } from './cache-store';
import { INDEX_TTS_ENGINE, parseCustomVoice } from './custom-voices';
import { measureDurationMs } from './duration';
import type { TtsProvider, TtsRequest, TtsResult } from './types';
import { TtsProviderError } from './types';

/**
 * 本地 IndexTTS2 的适配器——自定义音色就是靠它出声的。
 *
 * ## 零样本：没有"训练中"这一态
 *
 * IndexTTS2 不训练、不注册，**每次合成把参考音频和要念的文本一起发过去**，
 * 服务端不留状态。所以音色库那一侧要做的只有两件事：把参考音频留一份、
 * 记住用户给它起的名字；传完当场就能用。
 *
 * 这也解释了为什么样本文件必须复制进 userData（见 `voice-samples.ts`）：
 * 它不是"训练用过一次就可以扔"的素材，而是**每一次合成都要读**的输入。
 * 记原路径的话，用户哪天把桌面上那个录音删了，这条音色就再也念不出声了。
 *
 * ## 服务地址必须由外部给，不给默认值
 *
 * 本地服务跑在哪个端口因人而异。猜一个的话，"没配置"会表现成"连接被拒"，
 * 而后者看着像服务挂了——用户会去重启一个他根本没装的东西。
 *
 * ## 和火山那个 provider 的分工
 *
 * 由 `makeVoiceProvider` 按音色前缀分流（见 `router.ts`），这里不判断
 * "该不该用我"：适配器只管把一次请求发出去。
 */

export interface IndexTtsOptions {
    /** 服务地址，形如 `http://127.0.0.1:7860` */
    endpoint: string;
    /** 音频落盘目录 */
    outDir: string;
    /**
     * 参考音频在哪。返回 null 表示库里那条已经没了。
     *
     * 传一个查找函数而不是让适配器自己去翻音色库：这一层不该知道
     * 库是怎么存的，否则换个存法要动两处。
     */
    referenceOf: (sampleId: string) => Promise<string | null>;
    /** 语速倍率。不传按 1 倍 */
    speed?: number;
    /** 注入以便测试。默认用全局 fetch */
    fetchImpl?: typeof fetch;
    /** 注入时长探测以便测试 */
    measureDuration?: (file: string, scriptHash: string) => Promise<number>;
    /**
     * 单次请求上限，毫秒。
     *
     * 本地推理慢是常态，但**必须有上限**：服务卡住时没有超时的话，
     * 整条口播合成会一直挂着，用户既看不到进度也点不动取消。
     */
    timeoutMs?: number;
    /** 缓存元数据库。**可选**——不给就退回只看文件在不在 */
    cache?: TtsCacheStore;
}

const DEFAULT_TIMEOUT_MS = 120_000;

export class IndexTtsProvider implements TtsProvider {
    readonly name = INDEX_TTS_ENGINE;
    readonly model = INDEX_TTS_ENGINE;

    private readonly options: IndexTtsOptions;
    /** 末尾的斜杠去掉，拼出来才不会变成 `//tts` */
    private readonly base: string;

    constructor(options: IndexTtsOptions) {
        this.options = options;
        this.base = options.endpoint.replace(/\/+$/, '');
    }

    /** 带超时的一次请求。本地推理慢，但不能没有上限 */
    private async call(
        url: string,
        init: Parameters<typeof fetch>[1]
    ): Promise<Response> {
        const timeoutMs = this.options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
        const send = this.options.fetchImpl ?? fetch;
        const abort = new AbortController();
        const timer = setTimeout(() => {
            abort.abort();
        }, timeoutMs);

        try {
            return await send(url, { ...init, signal: abort.signal });
        } finally {
            clearTimeout(timer);
        }
    }

    /**
     * 服务在不在。
     *
     * **连不上就是没就绪，不是错误路径**——界面据此说一句"本地引擎没开"，
     * 比抛一个 ECONNREFUSED 让上层去猜有用得多。
     */
    async health(): Promise<boolean> {
        try {
            const response = await this.call(`${this.base}/health`, {
                method: 'GET'
            });
            return response.ok;
        } catch {
            return false;
        }
    }

    async synthesize(request: TtsRequest): Promise<TtsResult> {
        const text = request.text.trim();
        if (text === '') {
            throw new TtsProviderError(request.scriptHash, '文案是空的');
        }

        const ref = parseCustomVoice(request.voiceId);
        if (ref === null || ref.engine !== INDEX_TTS_ENGINE) {
            throw new TtsProviderError(
                request.scriptHash,
                `音色「${request.voiceId}」不是本地 IndexTTS2 的音色`
            );
        }

        const reference = await this.options.referenceOf(ref.sampleId);
        if (reference === null) {
            throw new TtsProviderError(
                request.scriptHash,
                `这条自定义音色找不到参考音频，可能是音色库里那条被删了`
            );
        }

        const speed = this.options.speed ?? 1;
        const timeoutMs = this.options.timeoutMs ?? DEFAULT_TIMEOUT_MS;

        /**
         * 先查缓存。本地推理慢是常态（所以上面才有 `timeoutMs`），
         * 能不跑就不跑。
         *
         * **`speed` 必须进键**：它就在下面那个请求体里，改了就是另一段音频。
         * 之前文件名只用 `scriptHash`，调完语速会落到同一个文件上——
         * 有了缓存之后，那就变成"听到的还是上一次那段"，而且没有任何报错。
         */
        const params = {
            scriptHash: request.scriptHash,
            voiceId: request.voiceId,
            speed,
            audioFormat: 'wav'
        };
        const file = cachedFilePath(this.options.outDir, params);
        const measure = this.options.measureDuration ?? measureDurationMs;
        const cached = await lookupCached(file, params, this.options.cache);
        if (cached !== null) {
            return {
                path: cached.path,
                // 有元数据库就直接读时长，没有才退回去量
                durationMs:
                    cached.durationMs ??
                    (await measure(cached.path, request.scriptHash)),
                provider: {
                    name: this.name,
                    model: this.model,
                    voiceId: request.voiceId
                }
            };
        }

        let response: Response;
        try {
            response = await this.call(`${this.base}/tts`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    text,
                    // 零样本克隆：参考音频每次都要带上，服务端不留状态
                    reference_audio: reference,
                    speed
                })
            });
        } catch (error) {
            // AbortError 的原文是 "This operation was aborted"，对用户毫无意义。
            // 说清楚是超时、超了多久，还是压根连不上
            throw new TtsProviderError(
                request.scriptHash,
                `本地 IndexTTS2 超过 ${Math.round(timeoutMs / 1000)} 秒没有响应，` +
                    `或者连不上 ${this.base}`,
                error
            );
        }

        if (!response.ok) {
            throw new TtsProviderError(
                request.scriptHash,
                `本地 IndexTTS2 返回 ${response.status}`
            );
        }

        const audio = Buffer.from(await response.arrayBuffer());
        if (audio.byteLength === 0) {
            // 空音频存下去，成片里就是一段无声，而工程校验拦不住它
            throw new TtsProviderError(
                request.scriptHash,
                '本地 IndexTTS2 返回了空音频'
            );
        }

        await mkdir(this.options.outDir, { recursive: true });
        await writeFile(file, audio);

        const durationMs = await measure(file, request.scriptHash);
        // 登记进缓存。本地推理慢，下次能省下的是整整一次推理
        this.options.cache?.put({
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
