import { Captions, Image as ImageIcon, Mic, Music } from 'lucide-react';

/**
 * 右侧图标栏的四个素材类型。
 *
 * 类型定义放在这里而不是 data/：这份清单就是 tab 的真源，
 * 配置区按它分发实现，编辑器页按它记当前选中项。
 */
export type EditorTab = 'visual' | 'voice' | 'subtitle' | 'music';

const items: { tab: EditorTab; Icon: typeof ImageIcon; label: string }[] = [
    { tab: 'visual', Icon: ImageIcon, label: '画面' },
    { tab: 'voice', Icon: Mic, label: '口播' },
    { tab: 'subtitle', Icon: Captions, label: '字幕' },
    { tab: 'music', Icon: Music, label: '音乐' }
];

interface IconRailProps {
    active: EditorTab;
    onChange: (tab: EditorTab) => void;
}

export default function IconRail({ active, onChange }: IconRailProps) {
    return (
        <nav
            aria-label="素材类型"
            className="flex w-[42px] shrink-0 flex-col items-center gap-7 overflow-hidden border-l border-ed-border bg-ed-bg pt-4"
        >
            {items.map(({ tab, Icon, label }) => {
                const current = tab === active;

                return (
                    <button
                        key={tab}
                        type="button"
                        aria-current={current ? 'true' : undefined}
                        onClick={() => onChange(tab)}
                        className="flex cursor-pointer flex-col items-center gap-1 transition-transform duration-150 active:scale-90"
                    >
                        {/* 动画挂在 span 而不是 svg 上：直接变换 SVG 元素在部分
                            渲染路径上会掉帧，包一层普通元素更稳 */}
                        <span className={`flex ${current ? 'rail-pop' : ''}`}>
                            <Icon
                                size={18}
                                className={`transition-colors duration-200 ${
                                    current
                                        ? 'text-ed-accent'
                                        : 'text-ed-text-2'
                                }`}
                            />
                        </span>
                        <span
                            className={`text-ed-2xs transition-colors duration-200 ${
                                current ? 'text-ed-accent' : 'text-ed-text-2'
                            }`}
                        >
                            {label}
                        </span>
                    </button>
                );
            })}
        </nav>
    );
}
