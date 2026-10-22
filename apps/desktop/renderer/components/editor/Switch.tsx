interface SwitchProps {
    /** 可达名称。视觉上的文字标签是兄弟节点，不在按钮里 */
    label: string;
    checked: boolean;
    onChange: (next: boolean) => void;
    /** 表面覆盖：音乐面板用 mu-* 那套色，与另外三个面板不同 */
    className?: string | undefined;
}

/**
 * 面板总开关。受控组件——状态由调用方持有。
 *
 * 音乐面板靠它控制底部操作条是否可用，所以不能再像原先那样把 aria-checked 写死。
 */
export default function Switch({
    label,
    checked,
    onChange,
    className = 'bg-ed-accent'
}: SwitchProps) {
    return (
        <button
            type="button"
            role="switch"
            aria-checked={checked}
            aria-label={label}
            onClick={() => onChange(!checked)}
            className={`relative h-[26px] w-12 shrink-0 cursor-pointer rounded-full transition-colors duration-200 ${
                checked ? className : 'bg-ed-border'
            }`}
        >
            {/* 滑块用 left 过渡而不是 transform：外层已经有 transition-colors，
                两个属性分开过渡互不干扰 */}
            <span
                className={`absolute top-[3px] size-5 rounded-full bg-white transition-[left] duration-200 ${
                    checked ? 'left-6' : 'left-[3px]'
                }`}
            />
        </button>
    );
}
