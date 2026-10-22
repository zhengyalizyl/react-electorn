import { z } from 'zod';

import type { StructuredOutputMethod, ThinkingMode } from './types';
import { ModelProviderConfigError } from './types';

/**
 * LLM 配置。**一处都不写死**——端点、模型、策略、思考开关全部从环境变量读，
 * 同 plan.md §10 的原则。
 *
 * 凭证只在主进程读取，绝不进渲染进程。
 */

const methodSchema = z.enum(['functionCalling', 'jsonSchema', 'jsonMode']);

export const llmConfigSchema = z.object({
    provider: z.enum(['ark', 'mock']).default('mock'),
    baseUrl: z.string().url(),
    apiKey: z.string().min(1),
    model: z.string().min(1),
    /**
     * 策略候选，**有序**。第一个是首选，后面是降级目标。
     *
     * 默认首选 `jsonSchema` —— 这是实测结论：同一提示词各跑 6 次，
     * `jsonSchema` 6/6 成功，`functionCalling` 只有 1/6（plan.md §4.2.1）。
     * 原因是 LangChain 在单工具时会强制 `tool_choice`，而方舟在强制模式下
     * 经常返回空的 `tool_calls`。
     */
    methods: z
        .array(methodSchema)
        .min(1)
        .default(['jsonSchema', 'functionCalling']),
    thinking: z.enum(['disabled', 'enabled']).default('disabled'),
    /**
     * 单次请求超时。
     *
     * 实测（2026-09-28，doubao-seed-2.0-pro）：开着 thinking 的规划类调用
     * 无图 96 秒、带一张图 156 秒。默认 120 秒会**把它们卡在门槛上**——
     * 实跑里 `DurationCheck` 就这么超时过一次，然后放弃了回压。
     *
     * 给到 240 秒：宁可等，也好过悄悄放弃一步。
     * 真卡死的请求由 `maxRetries` 那层兜。
     */
    timeoutMs: z.int().positive().default(240_000),
    /** 瞬时错误（限流 / 5xx / 超时）的重试次数 */
    maxRetries: z.int().nonnegative().default(2)
});

export type LlmConfig = z.infer<typeof llmConfigSchema>;

/** mock provider 不需要凭证——没网络没 key 也要能跑通整条流水线 */
const MOCK_DEFAULTS = {
    baseUrl: 'http://mock.invalid',
    apiKey: 'mock',
    model: 'mock-model'
} as const;

function splitMethods(raw: string | undefined): string[] | undefined {
    if (!raw) return undefined;
    const parts = raw
        .split(/[,\s]+/)
        .map((p) => p.trim())
        .filter(Boolean);
    return parts.length > 0 ? parts : undefined;
}

/**
 * 环境变量里的**空串等同于没配**。
 *
 * `ARK_API_KEY=`（等号后面什么都不写）是极常见的写法——模板里留着那一行、
 * 或者把 key 删掉忘了删行。`??` 对空串不生效，于是那个空串会一路走到 zod，
 * 换来一句「apiKey：Invalid input」。
 *
 * 那句话对用户毫无意义：他不知道 apiKey 是哪个变量，更不知道"invalid"
 * 指的是"空的"。拦在这里，缺凭证就是**真的缺**，上层那句
 * 「没有配置模型凭证，请建一个 .env …」才有机会说出口。
 *
 * `tts/config.ts` 早就为同一件事加过同名函数——这边当时漏了。
 */
function nonEmpty(value: string | undefined): string | undefined {
    return value === undefined || value.trim() === '' ? undefined : value;
}

/**
 * 从环境变量装配配置。
 *
 * **在启动阶段校验一次**：缺项、格式错、策略名不认识，都要在这里就报清楚，
 * 而不是跑到第 9 个节点才崩。
 */
export function loadLlmConfig(
    env: Record<string, string | undefined> = process.env
): LlmConfig {
    const provider = nonEmpty(env['LLM_PROVIDER']) ?? 'mock';
    const isMock = provider === 'mock';

    const raw = {
        provider,
        baseUrl:
            nonEmpty(env['ARK_BASE_URL']) ??
            (isMock ? MOCK_DEFAULTS.baseUrl : undefined),
        apiKey:
            nonEmpty(env['ARK_API_KEY']) ??
            (isMock ? MOCK_DEFAULTS.apiKey : undefined),
        model:
            nonEmpty(env['LLM_MODEL']) ??
            (isMock ? MOCK_DEFAULTS.model : undefined),
        methods: splitMethods(env['LLM_STRUCTURED_OUTPUT_METHOD']),
        thinking: env['LLM_THINKING'],
        timeoutMs: env['LLM_TIMEOUT_MS']
            ? Number(env['LLM_TIMEOUT_MS'])
            : undefined,
        maxRetries: env['LLM_MAX_RETRIES']
            ? Number(env['LLM_MAX_RETRIES'])
            : undefined
    };

    // undefined 要摘掉，否则会覆盖掉 schema 的 default
    const cleaned = Object.fromEntries(
        Object.entries(raw).filter(([, value]) => value !== undefined)
    );

    const parsed = llmConfigSchema.safeParse(cleaned);
    if (!parsed.success) {
        throw new ModelProviderConfigError(
            parsed.error.issues.map(
                (issue) => `${issue.path.join('.') || '(根)'}：${issue.message}`
            )
        );
    }
    return parsed.data;
}

/** 首选策略 */
export function primaryMethod(config: LlmConfig): StructuredOutputMethod {
    return config.methods[0]!;
}

/** 给定策略之后还能降到哪个；没有就返回 null */
export function nextMethod(
    config: LlmConfig,
    current: StructuredOutputMethod
): StructuredOutputMethod | null {
    const index = config.methods.indexOf(current);
    if (index < 0) return null;
    return config.methods[index + 1] ?? null;
}

export function resolveThinking(
    config: LlmConfig,
    override?: ThinkingMode
): ThinkingMode {
    return override ?? config.thinking;
}

/**
 * 备用 LLM 服务的配置。
 *
 * **三项齐了才算配好**（端点、key、模型），缺一就是没有备用——
 * 半配置比不配置更糟：以为有退路，真出事时才发现没有。
 *
 * 走的是 OpenAI 兼容协议，所以 DeepSeek / 通义 / OpenAI 乃至另一个方舟端点
 * 都能当备用，**不需要再写一个适配器**（`ArkChatModelProvider` 本来就是
 * 吃 `LlmConfig` 建 `ChatOpenAI`，方舟专属的只有那个 name）。
 *
 * ⚠️ 策略顺序**单独配**：`jsonSchema` 优先那条结论是方舟的实测（§4.2.1），
 * 别家未必一样。不配就跟主服务用同一套默认值。
 */
export function loadFallbackLlmConfig(
    env: Record<string, string | undefined> = process.env
): LlmConfig | null {
    const baseUrl = nonEmpty(env['LLM_FALLBACK_BASE_URL']);
    const apiKey = nonEmpty(env['LLM_FALLBACK_API_KEY']);
    const model = nonEmpty(env['LLM_FALLBACK_MODEL']);
    if (!baseUrl || !apiKey || !model) return null;

    const raw = {
        // 备用一律是真服务：配了凭证还退回 mock 的话，故障时等于没有备用
        provider: 'ark' as const,
        baseUrl,
        apiKey,
        model,
        methods: splitMethods(env['LLM_FALLBACK_STRUCTURED_OUTPUT_METHOD']),
        thinking: env['LLM_FALLBACK_THINKING'] ?? env['LLM_THINKING'],
        timeoutMs: env['LLM_TIMEOUT_MS']
            ? Number(env['LLM_TIMEOUT_MS'])
            : undefined,
        maxRetries: env['LLM_MAX_RETRIES']
            ? Number(env['LLM_MAX_RETRIES'])
            : undefined
    };
    const cleaned = Object.fromEntries(
        Object.entries(raw).filter(([, value]) => value !== undefined)
    );

    const parsed = llmConfigSchema.safeParse(cleaned);
    if (!parsed.success) {
        throw new ModelProviderConfigError(
            parsed.error.issues.map(
                (issue) =>
                    `备用服务 ${issue.path.join('.') || '(根)'}：${issue.message}`
            )
        );
    }
    return parsed.data;
}
