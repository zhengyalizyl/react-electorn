import type { LucideIcon } from 'lucide-react';

interface IconButtonProps {
    /** 图标组件本身，不是渲染结果 */
    icon: LucideIcon;
    /** 可达名称。纯图标按钮没有可见文字，缺了它读屏只会念「按钮」 */
    label: string;
    size?: number;
    /**
     * 按钮盒子的类，颜色也写在这里。
     *
     * lucide 图标默认 color="currentColor"，所以父级的 text-* 会被继承，
     * 不需要再单开一个 iconClassName。
     */
    className?: string;
    /** 不传就是个纯展示按钮，设计稿里大部分图标按钮还没接行为 */
    onClick?: (() => void) | undefined;
    /** 条件不满足时禁用。灰着但可点是最容易让人误会的状态 */
    disabled?: boolean | undefined;
    /**
     * 悬停提示。
     *
     * 置灰的按钮**必须说明为什么**：光灰着，用户只能猜是不是自己哪儿没做对。
     */
    title?: string | undefined;
}

/**
 * 纯图标按钮。
 *
 * 编辑器里这个形态出现 13 次（播放控件、时间线工具栏、折叠箭头、发送、试听……），
 * 每处都要重复 type="button" + aria-label + 一个定尺寸图标这三件事，
 * 漏掉 aria-label 就是无障碍缺陷，所以收敛成一个原语。
 *
 * cursor-pointer 统一在这里给，原先各调用点有的写了有的没写。
 */
export default function IconButton({
    icon: Icon,
    label,
    size = 16,
    className = '',
    onClick,
    disabled,
    title
}: IconButtonProps) {
    return (
        <button
            type="button"
            aria-label={label}
            onClick={onClick}
            disabled={disabled}
            {...(title === undefined ? {} : { title })}
            className={`cursor-pointer ${className}`}
        >
            <Icon size={size} />
        </button>
    );
}
