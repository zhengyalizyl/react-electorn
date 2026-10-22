import type {
    ModelProvider,
    ProviderEvent,
    StructuredRequest,
    StructuredResult,
    TextStreamRequest,
    TextStreamResult
} from './types';
import { classifyFailure } from './types';

/**
 * 厂商级降级：主服务整个不行时换下一家，**业务代码无感知**。
 *
 * ## 与策略级降级的分工
 *
 * `policy.ts` 那层解决的是"**这家厂商的这种调用方式**不行"——
 * `jsonSchema` 要不到结果就换 `functionCalling`，还在同一家。
 *
 * 这一层解决的是"**这家厂商整个不行**"：限流限到底、5xx、连不上。
 * 两层叠在一起才完整：先在家里想办法，想不出来再换一家。
 *
 * 顺序也是对的——`ArkChatModelProvider.invokeStructured` 内部已经跑完了
 * 重试与策略降级，抛到这一层的错已经是"这家尽力了"。
 *
 * ## 什么错才切
 *
 * | 分类 | 切不切 | 为什么 |
 * |---|---|---|
 * | `transient` | **切** | 限流、5xx、超时——这家挂了，换一家确实有救 |
 * | `unsupported` | **切** | 这家不认这种请求形状，别家可能认 |
 * | `empty` | **切** | 策略降级在这家已经试完了，还是空 |
 * | `malformed` | **切** | 同上，这家就是不吐 JSON |
 * | `schema` | **不切** | 模型已在按 JSON 说话却填错字段，那多半是**我们的 schema 或提示词**有问题。换一家只会把同一个错再犯一遍，钱付两份 |
 * | `fatal` | **不切** | 认不出来的错可能是我们自己的 bug，切了只是把损害翻倍 |
 *
 * ## 切过去就留在那儿
 *
 * 成功的那一家会被记住，后续请求直接从它开始。同 `ark.ts` 缓存
 * `activeMethod` 的理由：**不记的话 3000 个片段就是 3000 次明知必败的往返**，
 * 每次都要先等主服务超时一轮。
 *
 * 代价是**没有自动回切**：主服务恢复了也不会自己切回去，要重启应用。
 * 做自动回切要么定时探活（多一条后台请求）、要么按次数试探（会周期性地
 * 把真实请求打到一个可能还没好的服务上）。眼下不值得，但这是个明确的取舍。
 */

export interface FailoverOptions {
    onEvent?: (event: ProviderEvent) => void;
}

/** 这一类错换一家有救；那一类换了也白换 */
function shouldFailover(error: unknown): boolean {
    const kind = classifyFailure(error);
    return (
        kind === 'transient' ||
        kind === 'unsupported' ||
        kind === 'empty' ||
        kind === 'malformed'
    );
}

/**
 * 把错误消息里长得像凭证的东西抹掉。
 *
 * **事件会一路转发到渲染层**（plan.md §12），而服务端的报错里带上 key
 * 并不罕见——401 的响应体尤其爱把它回显出来。
 */
function redactSecrets(text: string): string {
    return text.replace(/\b(sk|ark)-[A-Za-z0-9._-]{6,}/gi, '$1-***');
}

function messageOf(error: unknown): string {
    return redactSecrets(
        error instanceof Error ? error.message : String(error)
    );
}

export class FailoverModelProvider implements ModelProvider {
    private readonly providers: readonly ModelProvider[];
    private readonly onEvent: (event: ProviderEvent) => void;
    /** 当前认定可用的那一家。切换成功后留在这里 */
    private active = 0;

    constructor(
        providers: readonly ModelProvider[],
        options: FailoverOptions = {}
    ) {
        if (providers.length === 0) {
            // 装配错误要在装配时就炸，不该等到第一次调用
            throw new Error('FailoverModelProvider 至少要有一个 provider');
        }
        this.providers = providers;
        this.onEvent = options.onEvent ?? ((): void => undefined);
    }

    /** 报的是**当前在用**的那一家，排查时看它而不是配置 */
    get name(): string {
        return this.providers[this.active]!.name;
    }

    async invokeStructured<T>(
        request: StructuredRequest<T>
    ): Promise<StructuredResult<T>> {
        return this.run(request.task, (provider) =>
            provider.invokeStructured(request)
        );
    }

    /**
     * 报告生成同样要保护。
     *
     * 它不如结构化数据要紧（少几个字只是读着不完整），但主服务挂了的时候
     * **整条运行都该还能走完**——报告生不出来会让用户以为运行失败了。
     */
    async streamText(request: TextStreamRequest): Promise<TextStreamResult> {
        return this.run(request.task, (provider) =>
            provider.streamText(request)
        );
    }

    /** 两个入口共用的一段：从当前这家开始，一路往后找 */
    private async run<T>(
        task: string,
        call: (provider: ModelProvider) => Promise<T>
    ): Promise<T> {
        let lastError: unknown;

        for (let i = this.active; i < this.providers.length; i += 1) {
            const provider = this.providers[i]!;
            try {
                const result = await call(provider);
                // 成功的那家记下来，下次直接从它开始
                this.active = i;
                return result;
            } catch (error) {
                lastError = error;
                const next = this.providers[i + 1];
                // 不该切的错、或者已经没有下一家了：如实抛出去
                if (!shouldFailover(error) || !next) throw error;

                this.onEvent({
                    type: 'provider_failover',
                    task,
                    from: provider.name,
                    to: next.name,
                    reason: messageOf(error)
                });
            }
        }

        // 循环只在"还有下一家"时继续，所以走到这里说明全试完了
        throw lastError;
    }
}
