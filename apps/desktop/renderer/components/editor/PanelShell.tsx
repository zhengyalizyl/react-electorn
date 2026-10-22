import type { ReactNode, Ref } from 'react';

import PanelFrame from '@/renderer/components/editor/PanelFrame';

interface PanelShellProps {
    /** 面板的可达性名称，也是测试定位当前模式的依据 */
    label: string;
    /**
     * 滚动容器本身。
     *
     * 「回到底部」那颗按钮要能滚它，也要知道现在是不是已经在底部了。
     * 滚动条挂在这一层，内容那一层拿不到——所以只能由外面把 ref 递进来。
     */
    scrollRef?: Ref<HTMLDivElement> | undefined;
    children: ReactNode;
}

/**
 * 整体滚动的面板：画面、字幕、音乐三个模式用这个。
 *
 * 全部内容在同一个滚动容器里，窗口不够高时整块一起滚。
 *
 * 横轴写死 hidden 是必须的——CSS 规定一轴为 auto/scroll 时，
 * 另一轴的 visible 会被计算成 auto，不压住就会多出一条横向滚动条。
 *
 * 口播模式的内容更长、且底部按钮要常驻，走 PinnedFooterShell。
 */
export default function PanelShell({
    label,
    scrollRef,
    children
}: PanelShellProps) {
    return (
        <PanelFrame label={label}>
            <div
                ref={scrollRef}
                className="flex min-h-0 w-full flex-1 flex-col gap-3 overflow-x-hidden overflow-y-auto p-4 scrollbar-ed"
            >
                {children}
            </div>
        </PanelFrame>
    );
}
