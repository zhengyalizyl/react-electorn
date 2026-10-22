import Switch from '@/renderer/components/editor/Switch';

interface SwitchFieldProps {
    /** 可见文字 */
    label: string;
    /**
     * 开关自己的可达名称。
     *
     * 和可见文字分开传：设计稿里音乐面板的可见文字是「开启」，
     * 单独念这两个字不知道开的是什么，读屏需要「开启背景音乐」。
     */
    switchLabel: string;
    checked: boolean;
    onChange: (next: boolean) => void;
    /** 文字样式覆盖，音乐面板用 mu-* 配色 */
    labelClassName?: string;
    /** 开关开启态的底色覆盖 */
    switchClassName?: string;
}

/**
 * 「文字 + 总开关」的一行，挂在 PanelHeading 的右侧插槽里。
 *
 * 字幕面板和音乐面板各用一次。
 */
export default function SwitchField({
    label,
    switchLabel,
    checked,
    onChange,
    labelClassName = 'text-ed-base font-bold text-ed-text',
    switchClassName
}: SwitchFieldProps) {
    return (
        <div className="flex items-center gap-2">
            <span className={labelClassName}>{label}</span>
            <Switch
                label={switchLabel}
                checked={checked}
                onChange={onChange}
                className={switchClassName}
            />
        </div>
    );
}
