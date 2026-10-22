import type { ReactNode } from 'react';

interface PanelFrameProps {
    /** 面板的可达性名称，也是测试定位当前模式的依据 */
    label: string;
    /**
     * 表面覆盖：底色与左描边。
     *
     * 音乐面板按独立设计稿 C1Sck 实现，用的是 mu-* 那套配色，
     * 和另外三个面板的 ed-* 不同，靠这个口子覆盖。
     */
    // 显式带上 undefined：tsconfig 开了 exactOptionalPropertyTypes，
    // 上游透传一个可能为 undefined 的值时，只写 `?:` 是不够的。
    className?: string | undefined;
    children: ReactNode;
}

/**
 * 右侧面板的外壳本体：宽度、左描边、底色。
 *
 * 自身不滚动也不留白——留白交给内部的滚动区，这样滚动条能贴在面板右缘，
 * 而不是被内边距顶进来 16px。
 *
 * 只被 PanelShell 与 PinnedFooterShell 两个变体使用，不要直接用。
 *
 * panel-enter 是切换素材类型时的入场动画，配合 ConfigPanel 上的 key 重挂载触发。
 */
export default function PanelFrame({
    label,
    className = 'border-ed-border bg-ed-bg',
    children
}: PanelFrameProps) {
    return (
        <aside
            aria-label={label}
            className={`panel-enter flex w-[323px] shrink-0 flex-col overflow-hidden border-l ${className}`}
        >
            {children}
        </aside>
    );
}
