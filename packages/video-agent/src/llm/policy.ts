import type { LlmConfig } from './config';
import { nextMethod, primaryMethod } from './config';
import type { ProviderEvent, StructuredOutputMethod } from './types';
import { classifyFailure } from './types';

/**
 * 重试与降级策略。
 *
 * 从 `ArkChatModelProvider` 里抽出来是为了**能在没有网络的情况下测它**——
 * 策略本身才是这里唯一有意思的逻辑，而它藏在一个要建 HTTP 连接的类里就等于测不了。
 * provider 只负责「发一次请求」，什么时候重试、什么时候降级由这里决定。
 */

export interface PolicyOptions {
    config: LlmConfig;
    task: string;
    onEvent?: (event: ProviderEvent) => void;
    /** 已确认可用的策略；没有就从配置的首选开始 */
    startMethod?: StructuredOutputMethod;
    /** 退避实现。测试里换成立即返回，免得白等几秒 */
    sleep?: (ms: number) => Promise<void>;
}

export interface PolicyResult<T> {
    value: T;
    /** 实际生效的策略。可能是降级后的，排查时看这个而不是配置 */
    method: StructuredOutputMethod;
}

const defaultSleep = (ms: number): Promise<void> =>
    new Promise((resolve) => {
        setTimeout(resolve, ms);
    });

/**
 * 按策略执行一次结构化调用。
 *
 * 四类错误四种处置，缺一不可：
 *
 * | 类别 | 处置 | 为什么 |
 * |---|---|---|
 * | `unsupported` | 立刻降级 | 重试同一个不支持的参数是纯浪费 |
 * | `transient` | 重试同策略，耗尽即抛 | 限流换策略也绕不开 |
 * | `empty` | 重试同策略，**耗尽后降级** | 换策略确实能绕开（实测 1/6 vs 6/6） |
 * | `malformed` | 同 `empty` | 没吐 JSON 时，换到在 API 层强制形状的 method 能治 |
 * | `schema` / `fatal` | 直接抛 | 换策略不会让模型突然学会遵守 schema |
 *
 * 把限流当成"不支持"会让整个进程永久停在次优策略上，而且这种退化是静默的。
 */
export async function executeWithPolicy<T>(
    options: PolicyOptions,
    attempt: (method: StructuredOutputMethod) => Promise<T>
): Promise<PolicyResult<T>> {
    const { config, task } = options;
    const emit = options.onEvent ?? ((): void => undefined);
    const sleep = options.sleep ?? defaultSleep;

    let method = options.startMethod ?? primaryMethod(config);

    for (;;) {
        let lastError: unknown;
        let downgrade = false;

        for (let tries = 0; tries <= config.maxRetries; tries += 1) {
            try {
                return { value: await attempt(method), method };
            } catch (error) {
                lastError = error;
                const kind = classifyFailure(error);

                if (kind === 'unsupported') {
                    downgrade = true;
                    break;
                }
                // 重试到头之后还能靠换策略救回来的两类：空响应、输出不是 JSON
                const downgradable = kind === 'empty' || kind === 'malformed';
                const retryable = kind === 'transient' || downgradable;
                if (retryable && tries === config.maxRetries && downgradable) {
                    downgrade = true;
                    break;
                }
                if (!retryable || tries === config.maxRetries) {
                    emit({
                        type: 'request_failed',
                        task,
                        method,
                        reason:
                            error instanceof Error
                                ? error.message
                                : String(error)
                    });
                    throw error;
                }

                emit({
                    type: 'request_retried',
                    task,
                    method,
                    attempt: tries + 1,
                    reason:
                        error instanceof Error ? error.message : String(error)
                });
                await sleep(500 * 2 ** tries);
            }
        }

        if (!downgrade) throw lastError;

        const fallback = nextMethod(config, method);
        if (!fallback) {
            emit({
                type: 'request_failed',
                task,
                method,
                reason: '已无可降级的策略'
            });
            throw noFallbackHint(config, method, lastError);
        }

        emit({
            type: 'method_downgraded',
            task,
            from: method,
            to: fallback,
            reason:
                lastError instanceof Error
                    ? lastError.message
                    : String(lastError)
        });
        method = fallback;
    }
}

/**
 * 无处可降时，把**为什么没有退路**写进报错本身。
 *
 * 原先这句只进事件流，抛出去的还是原始错误。于是界面上只剩
 * 「「ScriptRewrite」的响应里没有可解析的结构化内容」——读到的人知道失败了，
 * 却看不出是**策略被钉死成一个**才没有第二次机会，更不知道有
 * `LLM_STRUCTURED_OUTPUT_METHOD` 这个旋钮。
 *
 * 同 `ark.ts` 的 `timeoutHint`：**报错要说得出该调哪个旋钮。**
 * 只有一个策略时才加这句；配了多个却全试完了，那是真没辙，不必误导成配置问题。
 */
function noFallbackHint(
    config: LlmConfig,
    method: StructuredOutputMethod,
    error: unknown
): unknown {
    if (config.methods.length > 1) return error;
    if (!(error instanceof Error)) return error;

    return new Error(
        `${error.message}（当前只配了 ${method} 一种结构化输出策略，` +
            `失败后无处可降。可在 LLM_STRUCTURED_OUTPUT_METHOD 里按优先级写多个，` +
            `例如 jsonSchema,functionCalling；留空则用默认的两档）`,
        { cause: error }
    );
}
