import type { ReactNode } from 'react';

interface ChipProps {
    /** 排版与字号由调用方给：配置项的 chip 是纯文字，输入框的 chip 里还有图标和关闭按钮 */
    className?: string;
    children: ReactNode;
}

/**
 * 小圆角标签底。
 *
 * 圆角 6 + ed-border 描边 + ed-panel-2 底 + 内边距 8/4 这一组，
 * 在分段卡的配置项和输入框的分镜标签上是逐字相同的。
 *
 * 用 span 而不是 div：两处都处在行内语境，且 span 套 button 是合法结构。
 */
export default function Chip({ className = '', children }: ChipProps) {
    return (
        <span
            className={`rounded-md border border-ed-border bg-ed-panel-2 px-2 py-1 ${className}`}
        >
            {children}
        </span>
    );
}
