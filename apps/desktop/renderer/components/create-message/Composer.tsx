import { Loader2, Paperclip, SendHorizontal } from 'lucide-react';
import { useState } from 'react';

/**
 * 底部输入栏（设计稿 W8bPLG 的「聊天输入栏」）。
 *
 * ## 它只在「分镜确认」那一刻活着
 *
 * 图里有三个中断点，**只有分镜确认这一个能用一句话改**：它的契约里带着
 * `{ action: 'modify', scripts }`，把改过的文案交回去这条路本来就通。
 * 另外两个不行——需求文档只有放行一个动作（要改得回去改提示词），
 * 素材确认是在候选里挑，都不是一句话能表达的。
 *
 * 而且**在那儿改最划算**：图停着等人点头，再往后每一步都要花钱
 * （配素材要调模型，合成要按量计费）。
 *
 * 其余时候整栏禁用**并说清楚为什么**。能打字、能点发送、点完什么都不发生，
 * 比灰着难受得多——用户会以为自己的话被系统吃了。
 *
 * ## 改完不替用户点头
 *
 * 模型改出来的文案填进上面那几个文本框，由他看过再决定放不放行。
 * 直接放行的话，他根本没看见写成什么样，而那之后的钱已经花出去了。
 */

interface ComposerProps {
    /**
     * 现在能不能用。不传就是一直禁用（没有桥、或者还没跑起来）。
     *
     * 传进来的是**一句能照着做的话**：禁用时它就是提示文案。
     */
    disabledReason?: string | undefined;
    /** 把一句要求交出去。不传时整栏禁用 */
    onSubmit?: ((text: string) => Promise<void> | void) | undefined;
    /** 正在让模型改写 */
    busy?: boolean | undefined;
    /** 上一次改写失败的原因 */
    error?: string | null | undefined;
}

export default function Composer({
    disabledReason,
    onSubmit,
    busy = false,
    error = null
}: ComposerProps) {
    const [text, setText] = useState('');

    const live = onSubmit !== undefined && disabledReason === undefined;
    const canSend = live && text.trim() !== '' && !busy;

    const send = async (): Promise<void> => {
        if (!canSend) return;
        try {
            await onSubmit(text.trim());
            setText('');
        } catch {
            /**
             * **失败就把字留着。** 清掉的话用户那句要求得重打一遍，
             * 而原因由下面那条 `error` 说。
             */
        }
    };

    return (
        <div className="flex w-full flex-col gap-1.5">
            <div
                aria-label="继续对话"
                className={`flex w-full items-center gap-3 rounded-[14px] border border-msg-border bg-msg-card px-3 py-3 ${
                    live ? '' : 'opacity-60'
                }`}
            >
                <button
                    type="button"
                    disabled
                    aria-label="添加附件"
                    title="还不能带附件"
                    className="flex size-9 shrink-0 cursor-not-allowed items-center justify-center rounded-lg border border-msg-border text-msg-text-4"
                >
                    <Paperclip size={18} />
                </button>

                {live ? (
                    <textarea
                        aria-label="继续补充创作要求"
                        value={text}
                        onChange={(event) => setText(event.target.value)}
                        onKeyDown={(event) => {
                            // Enter 直接发，Shift+Enter 换行——聊天框的通用手感
                            if (event.key === 'Enter' && !event.shiftKey) {
                                event.preventDefault();
                                void send();
                            }
                        }}
                        placeholder="比如：第二段说得再简短一点"
                        className="min-h-[44px] w-full flex-1 resize-none bg-transparent text-ed-lg leading-ed text-ed-text caret-ed-text outline-none placeholder:text-msg-text-4"
                    />
                ) : (
                    <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                        <span className="truncate text-ed-lg text-msg-text-4">
                            继续补充创作要求，或要求智能体修改分镜
                        </span>
                        {/* **这句话不能省。** 只是灰着的话，用户不知道是坏了
                            还是现在不该用，更不知道什么时候才能用 */}
                        <span className="truncate text-ed-sm text-msg-text-4">
                            {disabledReason ??
                                '多轮对话是 P2 的事——现在这条片子跑完就结束了'}
                        </span>
                    </div>
                )}

                <button
                    type="button"
                    disabled={!canSend}
                    aria-label="发送"
                    onClick={() => void send()}
                    className="flex size-11 shrink-0 items-center justify-center rounded-[10px] border border-msg-border text-msg-text-4 enabled:cursor-pointer enabled:text-ed-text disabled:cursor-not-allowed"
                >
                    {busy ? (
                        <Loader2 size={18} className="animate-spin" />
                    ) : (
                        <SendHorizontal size={18} />
                    )}
                </button>
            </div>

            {busy ? (
                <span className="text-ed-sm text-msg-text-4">
                    正在按你的要求改这一版分镜…
                </span>
            ) : null}

            {error === null ? null : (
                <span role="alert" className="text-ed-sm text-ed-accent">
                    {`改不了：${error}`}
                </span>
            )}
        </div>
    );
}
