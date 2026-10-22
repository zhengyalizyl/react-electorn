import type { ReactNode } from 'react';

import PanelFrame from '@/renderer/components/editor/PanelFrame';

interface PinnedFooterShellProps {
    /** 面板的可达性名称，也是测试定位当前模式的依据 */
    label: string;
    /** 表面覆盖，透传给 PanelFrame */
    className?: string;
    /** 常驻顶部，不随中段滚动 */
    header: ReactNode;
    /**
     * 常驻底部的操作区。
     *
     * 传 null 时整块（含它的内边距）都不渲染——音乐面板未选中曲目时
     * 底部操作条不存在，留一个空的 padding 壳会凭空多出 28px。
     */
    footer: ReactNode;
    /** 中段，高度不够时只滚这一块 */
    children: ReactNode;
}

/**
 * 头部 + 可滚动中段 + 吸底操作区。
 *
 * 口播面板用它把「生成口播稿」钉在底部；音乐面板用它放选中曲目后的操作条。
 *
 * 留白分摊在三段上，加起来与 PanelShell 的 p-4 + gap-3 等价：
 * 顶部 16、头部与中段之间 12、中段与底部之间 12、底部 16。
 */
export default function PinnedFooterShell({
    label,
    className,
    header,
    footer,
    children
}: PinnedFooterShellProps) {
    return (
        <PanelFrame label={label} className={className}>
            <div className="w-full shrink-0 px-4 pt-4">{header}</div>

            <div className="flex min-h-0 w-full flex-1 flex-col gap-3 overflow-x-hidden overflow-y-auto px-4 pt-3 scrollbar-ed">
                {children}
            </div>

            {footer ? (
                <div className="w-full shrink-0 px-4 pt-3 pb-4">{footer}</div>
            ) : null}
        </PanelFrame>
    );
}
