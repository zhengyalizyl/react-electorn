import { labelOfNode } from '@/renderer/data/node-labels';

/**
 * 「正在做什么」的一行，跟在执行要点下面。
 *
 * 阶段只有四个，一个阶段里可能跑好几分钟——只看阶段的话，
 * 长节点期间这一页看着像卡死了。这一行报的是**当前节点**，粒度细一档。
 *
 * 三颗点在动，但动的只是点：**没有任何伪造的百分比**。
 */
export default function ActivityLine({ node }: { node: string | null }) {
    return (
        <p className="flex w-fit items-center gap-2.5 rounded-[10px] border border-msg-border bg-msg-inset px-4 py-2.5 text-ed-md text-msg-text-3">
            {node === null ? '正在启动' : `正在${labelOfNode(node)}`}
            <span aria-hidden="true" className="flex items-center gap-1">
                {[0, 1, 2].map((index) => (
                    <span
                        key={index}
                        className="size-1.5 animate-pulse rounded-full bg-msg-running motion-reduce:animate-none"
                        style={{ animationDelay: `${index * 160}ms` }}
                    />
                ))}
            </span>
        </p>
    );
}
