import type { ZodType } from 'zod';

/**
 * LLM provider 的对外接缝（B6a）。
 *
 * ## 为什么要有这一层
 *
 * 图节点**只认这个接口**，不直接 import langchain。换模型厂商、换 LangChain 版本、
 * 上 Mock，都只动 provider 实现。反过来如果节点直接拿 `ChatOpenAI`，
 * 「没凭证就跑不了任何测试」会立刻变成事实。
 *
 * 全仓有一条门禁：图节点里 grep 不到 langchain（见 tasks.md B6 的 DoD）。
 */

/** 结构化输出策略。取值与 LangChain 的 `withStructuredOutput` 对齐 */
export type StructuredOutputMethod =
    | 'functionCalling'
    | 'jsonSchema'
    | 'jsonMode';

/**
 * 思考开关。
 *
 * **在 `jsonSchema` 路径上这是真实的成本开关**：实测 reasoning token 325 → 0
 * 而输出质量没有区别（plan.md §4.2.1）。
 *
 * ⚠️ **在强制 tool calling 路径上它是 no-op**——那条路本身就不产生 reasoning，
 * 传什么都是 0。别看见开关就以为调它一定能省钱。
 */
export type ThinkingMode = 'disabled' | 'enabled';

/** 一张要送进多模态请求的图 */
export interface ImageInput {
    /** base64 编码的图片内容，**不含** `data:` 前缀 */
    base64: string;
    mimeType: string;
}

export interface TokenUsage {
    promptTokens: number;
    completionTokens: number;
    /** 思考消耗。关闭思考后应当是 0——这是验证开关真的生效的依据 */
    reasoningTokens: number;
    totalTokens: number;
}

export interface StructuredRequest<T> {
    /** 任务名。进事件流与错误归因，让「哪一步失败了」一眼可见 */
    task: string;
    schema: ZodType<T>;
    system?: string;
    user: string;
    /** 多模态输入。B4 打标送关键帧走这里 */
    images?: readonly ImageInput[];
    /** 覆盖本次请求的思考开关；不传就跟配置走 */
    thinking?: ThinkingMode;
    /**
     * ⚠️ 已废弃，勿用。流式请走 `streamText`。
     *
     * 曾经这里传了回调就改走流式，**并把流式文本当最终数据解析**。
     * 现在分开了：结构化数据一律 `withStructuredOutput(...).invoke()`，
     * 流式只用来生成给人看的报告——半截的流被当成工程数据解析，
     * 是那种"平时没事、偶尔毁掉一整条运行"的隐患。
     *
     * ## 为什么流式要单开一条路
     *
     * 实测（2026-09-23，方舟 doubao-seed-2.0-pro）：
     *
     * | 方式 | 块数 | 首字延迟 | 结论 |
     * |---|---|---|---|
     * | 裸文本 `.stream()` | ~1900 | 逐字 | 真流式 |
     * | `withStructuredOutput().stream()` | **1** | 31s | **假流式**，一次性给出 |
     * | `response_format: json_schema` + 裸流 | 549 | ~15s 后逐字 | 真流式，且末尾可解析 |
     *
     * 所以流式不能走 `withStructuredOutput`——它只在最后吐一块。
     * 走第三条：自己下 `response_format`，累计原始文本，末尾再按 schema 校验。
     *
     * 回调收到的是**增量**（不是累计），渲染层自己拼。
     */
    onDelta?: (delta: string) => void;
}

export interface StructuredResult<T> {
    value: T;
    usage: TokenUsage;
    /** 实际生效的策略。可能是降级后的，排查时要看这个而不是配置 */
    method: StructuredOutputMethod;
}

/**
 * provider 的可观测事件。形状与 plan.md §12 的 `AgentEvent` 对齐。
 *
 * **事件里绝不允许出现凭证或完整提示词**——事件会一路转发到渲染层。
 */
export type ProviderEvent =
    | {
          type: 'request_started';
          task: string;
          method: StructuredOutputMethod;
          images: number;
      }
    | {
          type: 'request_finished';
          task: string;
          method: StructuredOutputMethod;
          usage: TokenUsage;
      }
    | {
          /**
           * **厂商级**切换：这家整个不行了，换下一家。
           *
           * 与 `method_downgraded` 是两回事——那个是"这家的这种调用方式不行"。
           */
          type: 'provider_failover';
          task: string;
          from: string;
          to: string;
          reason: string;
      }
    | {
          type: 'method_downgraded';
          task: string;
          from: StructuredOutputMethod;
          to: StructuredOutputMethod;
          reason: string;
      }
    | {
          type: 'request_retried';
          task: string;
          method: StructuredOutputMethod;
          attempt: number;
          reason: string;
      }
    | {
          type: 'request_failed';
          task: string;
          method: StructuredOutputMethod;
          reason: string;
      };

/** 纯文本流式请求。**不带 schema**——它的产物是给人读的，不是给程序解析的 */
export interface TextStreamRequest {
    task: string;
    system?: string;
    user: string;
    /** 每收到一块就回调一次，参数是**增量** */
    onDelta: (delta: string) => void;
    thinking?: ThinkingMode;
}

export interface TextStreamResult {
    text: string;
    usage: TokenUsage;
}

export interface ModelProvider {
    readonly name: string;
    invokeStructured<T>(
        request: StructuredRequest<T>
    ): Promise<StructuredResult<T>>;

    /**
     * 流式生成一段**给人读的**文字。
     *
     * 与 `invokeStructured` 井水不犯河水：那边负责产出工程数据（要能解析、要守 schema），
     * 这边负责产出创作报告（要好读、要边写边出）。
     * 混在一起的话，流被掐断就会变成"工程数据缺了一半"。
     */
    streamText(request: TextStreamRequest): Promise<TextStreamResult>;
}

// ── 错误 ─────────────────────────────────────────────────────────────────
// 统一包装的意义：图层与 UI 拿到稳定形状，不必去区分
// 「LangChain 的校验失败」和「我们自己的业务校验失败」。

export class ModelProviderError extends Error {
    readonly task: string;
    override readonly cause?: unknown;

    constructor(task: string, message: string, cause?: unknown) {
        super(message);
        this.name = 'ModelProviderError';
        this.task = task;
        this.cause = cause;
    }
}

/** 模型的输出对不上 schema，且重试后仍然对不上 */
export class ModelProviderSchemaError extends ModelProviderError {
    readonly issues: readonly string[];

    constructor(task: string, issues: readonly string[], cause?: unknown) {
        super(
            task,
            `「${task}」的输出不符合 schema：${issues.join('；')}`,
            cause
        );
        this.name = 'ModelProviderSchemaError';
        this.issues = issues;
    }
}

/**
 * 服务端声称调用了工具，却没给出任何内容。
 *
 * 实测方舟在强制 `tool_choice` 时会返回 `finish_reason: tool_calls` 但
 * `tool_calls` 是空数组（6 次里 5 次）。**这是服务端故障，不是模型不守 schema**——
 * 所以归到 `transient` 去重试，而不是当成 schema 错误直接放弃。
 */
export class ModelProviderEmptyResponseError extends ModelProviderError {
    constructor(task: string) {
        super(task, `「${task}」的响应里没有可解析的结构化内容`);
        this.name = 'ModelProviderEmptyResponseError';
    }
}

/**
 * 模型根本没吐 JSON——回的是一段正文。
 *
 * **和 `ModelProviderSchemaError` 必须分开。** 后者是"格式对了、字段错了"，
 * 模型已经在按 JSON 说话，换个 method 不会让它突然学会填对字段；
 * 这个是"连格式都没遵守"，而 `jsonSchema` / `jsonMode` / `functionCalling`
 * 是在 API 层强制形状的，换过去确实能绕开。
 *
 * 混在一起的代价是真的：线上一次改写请求收到
 * `Unexpected token '底', "底部还能一键调出终端"... is not valid JSON`，
 * 原生 `SyntaxError` 匹配不上任何模式、落进 fatal，于是一次重试都没有，
 * 报错原样穿到界面上。
 */
export class ModelProviderMalformedOutputError extends ModelProviderError {
    /** 模型实际回的东西，截断后留个样本。排查时没有它只能靠猜 */
    readonly sample: string;

    constructor(task: string, sample: string, cause?: unknown) {
        const trimmed = sample.trim().slice(0, 120);
        super(
            task,
            `「${task}」的输出不是合法 JSON，模型大概直接回了正文：${trimmed}`,
            cause
        );
        this.name = 'ModelProviderMalformedOutputError';
        this.sample = trimmed;
    }
}

/** 配置缺失或非法。**在启动阶段抛**，而不是跑到第 9 个节点才崩 */
export class ModelProviderConfigError extends Error {
    readonly issues: readonly string[];

    constructor(issues: readonly string[]) {
        super(`LLM 配置不可用：${issues.join('；')}`);
        this.name = 'ModelProviderConfigError';
        this.issues = issues;
    }
}

/**
 * 错误分类——**降级逻辑的全部依据**。
 *
 * 把限流当成「不支持」会让整个进程永久停在次优策略上，所以这两类必须分开：
 * - `unsupported`：400 / 参数不认 → 降级换策略
 * - `transient`：超时、429、5xx → **重试同一个策略**，不降级
 */
export type FailureKind =
    /** 400 / 参数不认 → 立刻换策略 */
    | 'unsupported'
    /** 超时、429、5xx → **重试同一个策略**，耗尽就放弃 */
    | 'transient'
    /**
     * 服务端返回了空的结构化内容 → 先重试同一个策略，**耗尽后再降级**。
     *
     * 单独成一类的原因：它既不是"参数不支持"（重试有意义），
     * 也不是纯瞬时故障（换个策略确实能绕开——实测 `functionCalling` 1/6、
     * `jsonSchema` 6/6）。混进 transient 就永远降不了级，混进 unsupported
     * 就连一次重试都不给。
     */
    | 'empty'
    /**
     * 模型压根没吐 JSON，回的是正文 → **与 `empty` 同样处置**：先重试同一个策略，
     * 耗尽后降级。
     *
     * 和 `schema` 分开的理由见 `ModelProviderMalformedOutputError`：那个是
     * "格式对了字段错"，这个是"连格式都没遵守"，而换 method 正好能强制住格式。
     */
    | 'malformed'
    /** 模型不守 schema → 换策略也没用，直接抛 */
    | 'schema'
    | 'fatal';

const TRANSIENT_PATTERNS = [
    /rate.?limit/i,
    /too many requests/i,
    /timeout/i,
    /timed out/i,
    /ECONNRESET/i,
    /ETIMEDOUT/i,
    /socket hang up/i,
    /\b(429|500|502|503|504)\b/
];

/**
 * 原生 JSON 解析失败的几种措辞。
 *
 * V8 的 `SyntaxError` 在不同 Node 版本上文案不一样（`Unexpected token x in JSON`
 * 与 `... is not valid JSON` 都见过），所以认的是几个稳定片段而不是整句。
 */
const MALFORMED_PATTERNS = [
    /is not valid json/i,
    /unexpected token.*json/i,
    /unexpected end of json/i,
    /^SyntaxError\b.*unexpected token/i
];

const UNSUPPORTED_PATTERNS = [
    /unsupported/i,
    /invalid.?parameter/i,
    /not supported/i,
    /unrecognized/i,
    /does not support/i,
    /\b400\b/
];

/** 从任意错误里判定它属于哪一类。先判瞬时，再判不支持——限流响应里也常带 400 字样 */
export function classifyFailure(error: unknown): FailureKind {
    // 顺序有讲究：空响应与畸形输出都是 ModelProviderError 的子类，要先于 schema 判
    if (error instanceof ModelProviderEmptyResponseError) return 'empty';
    if (error instanceof ModelProviderMalformedOutputError) return 'malformed';
    if (error instanceof ModelProviderSchemaError) return 'schema';

    const status = (error as { status?: unknown })?.status;
    if (typeof status === 'number') {
        if (status === 429 || status >= 500) return 'transient';
        if (status === 400 || status === 404 || status === 422)
            return 'unsupported';
    }

    const text =
        error instanceof Error
            ? `${error.name} ${error.message}`
            : String(error);
    if (TRANSIENT_PATTERNS.some((p) => p.test(text))) return 'transient';
    if (UNSUPPORTED_PATTERNS.some((p) => p.test(text))) return 'unsupported';
    // 没被我们包装过就漏出来的原生解析错——LangChain 内部 JSON.parse 抛的就是它。
    // `ark.ts` 已经在源头兜了一道，这里是第二层网：少一条路径没兜到，
    // 代价是整次调用一次重试都不给
    if (MALFORMED_PATTERNS.some((p) => p.test(text))) return 'malformed';
    return 'fatal';
}
