import { HumanMessage, SystemMessage } from '@langchain/core/messages';
import { ChatOpenAI } from '@langchain/openai';

import type { LlmConfig } from './config';
import { primaryMethod, resolveThinking } from './config';
import { executeWithPolicy } from './policy';
import type {
    ImageInput,
    ModelProvider,
    ProviderEvent,
    StructuredOutputMethod,
    StructuredRequest,
    StructuredResult,
    TextStreamRequest,
    TextStreamResult,
    ThinkingMode,
    TokenUsage
} from './types';
import {
    ModelProviderEmptyResponseError,
    ModelProviderMalformedOutputError,
    ModelProviderSchemaError
} from './types';

/**
 * 这个异常是不是"模型回的不是 JSON"。
 *
 * 只认解析失败，**不认别的 `SyntaxError`**：网络层、SDK 内部的语法错不该被
 * 当成模型的锅拿去重试三遍再降级。V8 在不同 Node 版本上的文案不一样
 * （`Unexpected token x in JSON` 与 `... is not valid JSON` 都见过），
 * 所以认的是稳定片段。
 */
function isJsonParseFailure(error: unknown): boolean {
    const message = error instanceof Error ? error.message : String(error);
    return (
        /is not valid json/i.test(message) ||
        /unexpected token.*json/i.test(message) ||
        /unexpected end of json/i.test(message) ||
        (error instanceof SyntaxError && /unexpected token/i.test(message))
    );
}

/**
 * 火山方舟 provider。
 *
 * **这是全仓唯一 import langchain 的地方。** 图节点只认 `ModelProvider` 接口——
 * 换厂商、换 LangChain 版本都不该波及它们。tasks.md B6 的 DoD 里有一条门禁：
 * 图节点里 grep 不到 langchain。
 *
 * 接入要点全部由实跑冒烟坐实（plan.md §4.2.1）：
 * - 方舟是 OpenAI-compatible，走 `ChatOpenAI` + `configuration.baseURL`
 * - `BASE_URL` 是 `/api/plan/v3`，不是 `/api/v3`
 * - json_schema 与 tool calling 在 `/chat/completions` 上都可用，
 *   但 **tool calling 经由 LangChain 只有 1/6 成功率**，所以默认走 json_schema
 * - 多模态、结构化输出、关闭思考**三者可叠加**
 */

interface RawUsageShape {
    prompt_tokens?: unknown;
    completion_tokens?: unknown;
    total_tokens?: unknown;
    completion_tokens_details?: { reasoning_tokens?: unknown };
}

function num(value: unknown): number {
    return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

/**
 * 从原始响应里抠 usage。
 *
 * 走 LangChain 标准化后的 `tokenUsage` 拿不到 `reasoning_tokens`——
 * 那是方舟特有字段，标准结构里没有位置。而它恰恰是**验证「关闭思考」真的生效**
 * 的唯一依据（plan.md §4.2.1），所以必须从原始对象里取。
 */
export function extractUsage(raw: unknown): TokenUsage {
    const metadata = (raw as { response_metadata?: Record<string, unknown> })
        ?.response_metadata;
    const usage = (metadata?.['usage'] ??
        metadata?.['tokenUsage'] ??
        {}) as RawUsageShape;

    const promptTokens = num(usage.prompt_tokens);
    const completionTokens = num(usage.completion_tokens);
    return {
        promptTokens,
        completionTokens,
        reasoningTokens: num(usage.completion_tokens_details?.reasoning_tokens),
        totalTokens: num(usage.total_tokens) || promptTokens + completionTokens
    };
}

/**
 * 图片内容块。
 *
 * ⚠️ **必须用 OpenAI 原生的 `image_url` 形状，不能用 LangChain v1 的
 * `{ type: 'image', mimeType, data }`。**
 *
 * v1 那个块是 LangChain 的统一抽象，但 `chat_models/completions` 适配层**不会**
 * 把它翻译成 `image_url` —— 它原样透传，方舟直接 400：
 *
 * > invalid value: `image`, supported values are: `text`, `image_url`, …
 *
 * 这是实跑才发现的：类型检查全过，单测也测不到（没有网络就没有这一步）。
 */
function toImageBlock(image: ImageInput): Record<string, unknown> {
    return {
        type: 'image_url',
        image_url: { url: `data:${image.mimeType};base64,${image.base64}` }
    };
}

export interface ArkProviderOptions {
    config: LlmConfig;
    onEvent?: (event: ProviderEvent) => void;
    /**
     * 这个 provider 叫什么，进事件与报错。
     *
     * 默认 `ark`。做厂商级降级时**必须给备用起个别的名字**——
     * 两家都叫 ark 的话，`provider_failover` 事件会写成"从 ark 切到 ark"，
     * 排查时完全看不出发生过什么。
     */
    name?: string;
}

export class ArkChatModelProvider implements ModelProvider {
    readonly name: string;

    private readonly config: LlmConfig;
    private readonly onEvent: (event: ProviderEvent) => void;

    /**
     * 本进程内已确认可用的策略。
     *
     * 降级结果必须缓存：否则 3000 个片段就是 3000 次明知必败的往返。
     */
    private activeMethod: StructuredOutputMethod;

    /** 按思考模式缓存模型实例——`thinking` 是构造参数，不能按请求切 */
    private readonly models = new Map<ThinkingMode, ChatOpenAI>();

    constructor(options: ArkProviderOptions) {
        this.name = options.name ?? 'ark';
        this.config = options.config;
        this.onEvent = options.onEvent ?? ((): void => undefined);
        this.activeMethod = primaryMethod(options.config);
    }

    private modelFor(thinking: ThinkingMode): ChatOpenAI {
        const cached = this.models.get(thinking);
        if (cached) return cached;

        const model = new ChatOpenAI({
            model: this.config.model,
            apiKey: this.config.apiKey,
            configuration: { baseURL: this.config.baseUrl },
            timeout: this.config.timeoutMs,
            // 重试由 policy.ts 按 FailureKind 控制：LangChain 的内建重试
            // 会把"不支持"也一起重试，那是纯浪费
            maxRetries: 0,
            // `thinking` 不是 OpenAI 的标准参数，只能从 modelKwargs 透传进请求体。
            // 透传是否真的生效由 live 测试验证（对比两种模式的 reasoningTokens）——
            // 类型检查永远证明不了这件事
            modelKwargs: { thinking: { type: thinking } }
        });
        this.models.set(thinking, model);
        return model;
    }

    async invokeStructured<T>(
        request: StructuredRequest<T>
    ): Promise<StructuredResult<T>> {
        const thinking = resolveThinking(this.config, request.thinking);
        let usage: TokenUsage = {
            promptTokens: 0,
            completionTokens: 0,
            reasoningTokens: 0,
            totalTokens: 0
        };

        const outcome = await this.withTimeoutHint(() =>
            executeWithPolicy<T>(
                {
                    config: this.config,
                    task: request.task,
                    onEvent: this.onEvent,
                    startMethod: this.activeMethod
                },
                async (method) => {
                    const result = await this.runOnce(
                        request,
                        method,
                        thinking
                    );
                    usage = result.usage;
                    return result.value;
                }
            )
        );

        // 成功才落盘活跃策略，失败时不要把降级中间态记下来
        this.activeMethod = outcome.method;
        return { value: outcome.value, usage, method: outcome.method };
    }

    /**
     * 超时的报错要**说得出该调哪个旋钮**（实现见模块底部的 `timeoutHint`）。
     *
     * 原样抛出去只有一句 `Request timed out.`——它会被上层包成
     * 「精排未生效，退回检索首位：Request timed out.」或
     * 「按目标时长改写失败：Request timed out.」。读到的人知道慢了，
     * 但不知道当前设的是几秒、更不知道有 `LLM_TIMEOUT_MS` 这个东西。
     *
     * 实测：开着 thinking 的规划类调用无图 96 秒、带一张图 156 秒——
     * 卡在 120 秒的人会以为是模型坏了，而不是自己的配置太紧。
     */
    private async withTimeoutHint<T>(run: () => Promise<T>): Promise<T> {
        try {
            return await run();
        } catch (error) {
            const text = error instanceof Error ? error.message : String(error);
            const hinted = timeoutHint(text, this.config.timeoutMs);
            if (hinted === null) throw error;
            throw new Error(hinted, { cause: error });
        }
    }

    private async runOnce<T>(
        request: StructuredRequest<T>,
        method: StructuredOutputMethod,
        thinking: ThinkingMode
    ): Promise<{ value: T; usage: TokenUsage }> {
        const images = request.images ?? [];
        this.onEvent({
            type: 'request_started',
            task: request.task,
            method,
            images: images.length
        });

        const content: Record<string, unknown>[] = [
            { type: 'text', text: request.user },
            ...images.map(toImageBlock)
        ];
        const messages = [
            ...(request.system ? [new SystemMessage(request.system)] : []),
            // LangChain v1 的 content 类型不认 `image_url` 这种"旧"块，
            // 但服务端只认它（见 toImageBlock）。类型与运行时冲突时以运行时为准。
            new HumanMessage({ content } as never)
        ];

        // includeRaw 才拿得到 usage——§11 的成本记账与 §12 的事件流都要它
        const structured = this.modelFor(thinking).withStructuredOutput(
            request.schema,
            { method, includeRaw: true, name: request.task }
        );

        /**
         * 这里要兜一道：模型没按 JSON 回时，**LangChain 内部的 `JSON.parse`
         * 会抛原生 `SyntaxError`**，而那个错谁也认不出来——分类器只会把它
         * 归到 fatal，于是一次重试都没有，`Unexpected token '底', "底部还能一
         * 键调出终端"... is not valid JSON` 就这么原样穿到界面上了。
         *
         * 包成我们自己的错误形状，它才进得了重试与降级那条路（见 policy.ts）。
         */
        let response: { parsed: unknown; raw: unknown };
        try {
            response = (await structured.invoke(messages)) as {
                parsed: unknown;
                raw: unknown;
            };
        } catch (error) {
            if (!isJsonParseFailure(error)) throw error;
            const message = error instanceof Error ? error.message : '';
            this.onEvent({
                type: 'request_failed',
                task: request.task,
                method,
                reason: `输出不是合法 JSON：${message}`
            });
            throw new ModelProviderMalformedOutputError(
                request.task,
                message,
                error
            );
        }
        const usage = extractUsage(response.raw);

        // `parsed` 为 undefined = 服务端说调了工具但没给内容。
        // 这不是"模型不守 schema"，归到可重试的那一类去（见 types.ts）
        if (response.parsed === undefined || response.parsed === null) {
            this.onEvent({
                type: 'request_failed',
                task: request.task,
                method,
                reason: '响应里没有结构化内容'
            });
            throw new ModelProviderEmptyResponseError(request.task);
        }

        // LangChain 已按 schema 校验过；这里再 parse 一次是为了拿到**我们自己的**
        // 错误形状，让图层不必区分错误来自哪一层
        const parsed = request.schema.safeParse(response.parsed);
        if (!parsed.success) {
            const issues = parsed.error.issues.map(
                (issue) => `${issue.path.join('.') || '(根)'}：${issue.message}`
            );
            this.onEvent({
                type: 'request_failed',
                task: request.task,
                method,
                reason: `schema 不符：${issues.join('；')}`
            });
            throw new ModelProviderSchemaError(request.task, issues);
        }

        this.onEvent({
            type: 'request_finished',
            task: request.task,
            method,
            usage
        });
        return { value: parsed.data, usage };
    }

    /**
     * 流式生成一段给人读的文字。
     *
     * ## 为什么与结构化输出分开
     *
     * 结构化数据必须能解析、必须守 schema——流被掐断就毁掉一整条运行。
     * 而报告是给人看的：少几个字无非是读着不完整，代价完全不同。
     * 所以这边**不带 schema、不做解析**，拿到什么显示什么。
     *
     * 实测（方舟 doubao-seed-2.0-pro）：裸文本流约 1900 块、逐字到达。
     */
    async streamText(request: TextStreamRequest): Promise<TextStreamResult> {
        const thinking = resolveThinking(this.config, request.thinking);
        const messages = [
            ...(request.system ? [new SystemMessage(request.system)] : []),
            new HumanMessage(request.user)
        ];

        let text = '';
        let usage: TokenUsage = {
            promptTokens: 0,
            completionTokens: 0,
            reasoningTokens: 0,
            totalTokens: 0
        };

        const stream = await this.modelFor(thinking).stream(messages);
        for await (const chunk of stream) {
            // **只取正文**。推理链不进这里，也就不会被转发到界面上
            const delta =
                typeof chunk.content === 'string' ? chunk.content : '';
            if (delta !== '') {
                text += delta;
                request.onDelta(delta);
            }
            const chunkUsage = extractUsage(chunk);
            if (chunkUsage.totalTokens > 0) usage = chunkUsage;
        }

        return { text, usage };
    }
}

/**
 * 给超时报错补上"该调哪个旋钮"。不是超时就返回 null，交给调用方原样抛。
 *
 * 原样抛出去只有一句 `Request timed out.`——它会被上层包成
 * 「精排未生效，退回检索首位：Request timed out.」或
 * 「按目标时长改写失败：Request timed out.」。读到的人知道慢了，
 * 但不知道当前设的是几秒、更不知道有 `LLM_TIMEOUT_MS` 这个东西。
 *
 * 实测：开着思考的规划类调用无图 96 秒、带一张图 156 秒——
 * 卡在 120 秒的人会以为是模型坏了，而不是自己的配置太紧。
 */
export function timeoutHint(message: string, timeoutMs: number): string | null {
    if (!/timed out|timeout|ETIMEDOUT/i.test(message)) return null;
    return (
        `${message}（当前单次请求上限 ${Math.round(timeoutMs / 1000)} 秒；` +
        `开着思考的规划类调用实测要 96～156 秒，` +
        `可用环境变量 LLM_TIMEOUT_MS 调大）`
    );
}
