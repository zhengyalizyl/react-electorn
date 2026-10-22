import type {
    ModelProvider,
    ProviderEvent,
    StructuredRequest,
    StructuredResult,
    TextStreamRequest,
    TextStreamResult,
    TokenUsage
} from './types';
import { ModelProviderSchemaError } from './types';

/**
 * 无凭证、无网络的 provider。
 *
 * **不是可选项。** 没有它，整条流水线在没凭证、没网络时一步都跑不通——
 * 开发做不了，CI 做不了，测试也做不了。所以它是 B6a 的必要组成，
 * 不是"顺手加的方便功能"。
 *
 * 用法：按任务名注册应答器。没注册的任务会抛错而不是返回空对象——
 * 静默返回空对象会让下游在离故障点很远的地方崩，排查成本极高。
 */

export type MockResponder = (request: StructuredRequest<unknown>) => unknown;

export interface MockProviderOptions {
    /** 任务名 → 应答器。值可以是常量，也可以按请求内容变化 */
    responders?: Record<string, MockResponder | unknown>;
    onEvent?: (event: ProviderEvent) => void;
    /** 每次调用的模拟延迟，用来观察进度事件 */
    latencyMs?: number;
}

const MOCK_USAGE: TokenUsage = {
    promptTokens: 0,
    completionTokens: 0,
    reasoningTokens: 0,
    totalTokens: 0
};

export class MockModelProvider implements ModelProvider {
    readonly name = 'mock';

    private readonly responders: Map<string, MockResponder>;
    private readonly onEvent: (event: ProviderEvent) => void;
    private readonly latencyMs: number;

    /** 收到过的请求，供测试断言「发过去的到底是什么」 */
    readonly calls: StructuredRequest<unknown>[] = [];

    constructor(options: MockProviderOptions = {}) {
        this.responders = new Map(
            Object.entries(options.responders ?? {}).map(([task, value]) => [
                task,
                typeof value === 'function'
                    ? (value as MockResponder)
                    : (): unknown => value
            ])
        );
        this.onEvent = options.onEvent ?? ((): void => undefined);
        this.latencyMs = options.latencyMs ?? 0;
    }

    /** 事后注册。测试里常常要按用例换应答 */
    setResponder(task: string, responder: MockResponder | unknown): void {
        this.responders.set(
            task,
            typeof responder === 'function'
                ? (responder as MockResponder)
                : (): unknown => responder
        );
    }

    /**
     * 流式文本的假实现：**一小块一小块地吐**，而不是一次性给全。
     *
     * 一次性给全的话，"消息原地增长"这类行为在测试里根本走不到——
     * 真机上它是几百块，假的至少也要是多块。
     */
    async streamText(request: TextStreamRequest): Promise<TextStreamResult> {
        const responder = this.responders.get(request.task);
        const text =
            responder === undefined
                ? `（${request.task} 的占位报告）`
                : String(responder(request as never));

        for (const piece of text.match(/.{1,8}/gs) ?? []) {
            request.onDelta(piece);
        }

        return {
            text,
            usage: {
                promptTokens: 0,
                completionTokens: 0,
                reasoningTokens: 0,
                totalTokens: 0
            }
        };
    }

    async invokeStructured<T>(
        request: StructuredRequest<T>
    ): Promise<StructuredResult<T>> {
        this.calls.push(request as StructuredRequest<unknown>);
        this.onEvent({
            type: 'request_started',
            task: request.task,
            method: 'functionCalling',
            images: request.images?.length ?? 0
        });

        if (this.latencyMs > 0) {
            await new Promise((resolve) => {
                setTimeout(resolve, this.latencyMs);
            });
        }

        const responder = this.responders.get(request.task);
        if (!responder) {
            throw new Error(
                `MockModelProvider 没有为任务「${request.task}」注册应答。` +
                    `已注册：${[...this.responders.keys()].join('、') || '(无)'}`
            );
        }

        // Mock 的产物**也要过 schema**。不校验的话，fixture 写错了会一路漏到
        // 下游才炸，而那时已经看不出是 mock 数据的问题
        const parsed = request.schema.safeParse(
            responder(request as StructuredRequest<unknown>)
        );
        if (!parsed.success) {
            throw new ModelProviderSchemaError(
                request.task,
                parsed.error.issues.map(
                    (issue) =>
                        `${issue.path.join('.') || '(根)'}：${issue.message}`
                )
            );
        }

        this.onEvent({
            type: 'request_finished',
            task: request.task,
            method: 'functionCalling',
            usage: MOCK_USAGE
        });
        return {
            value: parsed.data,
            usage: MOCK_USAGE,
            method: 'functionCalling'
        };
    }
}
