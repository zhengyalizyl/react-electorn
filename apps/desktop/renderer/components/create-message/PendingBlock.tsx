import type { ReactNode } from 'react';

/**
 * 等你确认的那一段（设计稿 W8bPLG 里用户要点「确认并继续」的位置）。
 *
 * ## 为什么要换个颜色
 *
 * 图**真的停在这里**等答复：不点，主进程那条运行就一直挂着。
 * 和普通助手消息长一个样的话，用户会以为它还在跑，就那么等下去——
 * 实跑里这种"以为在跑其实在等"的状态最难受。
 *
 * 所以待确认的块用琥珀色描边 + 一枚「等你确认」标签，和其余消息一眼分得开；
 * 确认过之后**恢复成普通样子**：那时它只是历史，不该继续抢注意力。
 */
export default function PendingBlock({ children }: { children: ReactNode }) {
    return (
        <div
            // 有名字的分组：读屏能报出"待确认"，测试也能精确定位到这一块
            role="group"
            aria-label="待确认"
            className="flex w-full flex-col gap-3 rounded-[14px] border border-msg-running/60 bg-[#F6B84B14] p-4"
        >
            <span className="flex w-fit items-center gap-1.5 rounded-full border border-msg-running/60 px-2.5 py-1 text-ed-sm text-msg-running">
                <span
                    aria-hidden="true"
                    className="size-1.5 animate-pulse rounded-full bg-msg-running motion-reduce:animate-none"
                />
                等你确认
            </span>
            {children}
        </div>
    );
}
