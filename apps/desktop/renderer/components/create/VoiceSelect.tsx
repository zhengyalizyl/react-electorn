import { Check, ChevronDown } from 'lucide-react';
import { useEffect, useRef } from 'react';

import type { VoiceCategory } from '@magicut-react-demo/video-agent/voices';
import {
    VOICE_CATALOG,
    voiceSubtitle
} from '@magicut-react-demo/video-agent/voices';

/**
 * 下拉里的一项。
 *
 * 比 `VoiceSpec` 宽：用户自己克隆的音色没有「适用场景」也没有「XX 同款」，
 * 硬塞成 `VoiceSpec` 只能给它编一个场景分类——而那是假数据。
 * 这里只要三样：选中后发出去的 id、显示名、下面那行说明。
 */
export interface VoiceOption {
    id: string;
    name: string;
    desc: string;
}

interface VoiceSelectProps {
    value: VoiceOption;
    /**
     * 用户自己传的音色，单独一组排在最前。
     *
     * **排最前**是因为：会去传音色的人，多半就是冲着用自己的声音来的，
     * 让他每次先滚过 19 个官方音色不合理。空数组时整组不出现，
     * 不留一个空标题。
     */
    custom?: readonly VoiceOption[];
    open: boolean;
    onToggle: () => void;
    onSelect: (id: string) => void;
    onClose: () => void;
}

/**
 * 配音选择器。
 *
 * ## 列表是真音色，不是设计稿里的占位
 *
 * 官方选项直接来自 `@magicut-react-demo/video-agent/voices` 的 19 个火山 2.0
 * 中文音色。**界面上选的那个 id 会原样发给主进程**（`start(prompt, voiceId)`），
 * 所以这里绝不能自己编名字——编出来的 id 到了合成那步只会换来一个服务端拒绝。
 *
 * 按官方的「适用场景」分组：19 项平铺成一列谁也挑不动，
 * 而这三组恰好就是用户心里的问题——做口播、演角色、还是读书。
 * 自定义音色不属于其中任何一组，所以它**自成一组**，
 * 而不是塞进「通用场景」冒充官方音色。
 *
 * 交互上仍然是可开合的：点按钮开合，选中收起，点外面或按 Esc 也收起。
 */

/** 分组顺序即官方列表里的出现顺序，通用场景占大头放最前 */
const CATEGORIES: readonly VoiceCategory[] = [
    '通用场景',
    '角色扮演',
    '有声阅读'
];

/** 官方音色 → 下拉项。说明只拼 id 与官方标注里已有的信息，不编造 */
export function catalogOption(voice: {
    id: string;
    name: string;
    category: VoiceCategory;
    platforms?: readonly string[];
}): VoiceOption {
    return { id: voice.id, name: voice.name, desc: voiceSubtitle(voice) };
}

export default function VoiceSelect({
    value,
    custom = [],
    open,
    onToggle,
    onSelect,
    onClose
}: VoiceSelectProps) {
    const rootRef = useRef<HTMLDivElement>(null);

    /**
     * 自定义音色一组，官方三组。
     *
     * 收成一张表再统一渲染，是为了让两类音色**走同一条渲染路径**——
     * 各写一份的话，哪天改了选中态的样式只会改到其中一半。
     *
     * 音色库是空的就整组不出现：一个空标题比没有更难理解。
     */
    const groups: { label: string; items: readonly VoiceOption[] }[] = [
        ...(custom.length > 0 ? [{ label: '我的音色', items: custom }] : []),
        ...CATEGORIES.map((category) => ({
            label: category,
            items: VOICE_CATALOG.filter(
                (voice) => voice.category === category
            ).map(catalogOption)
        }))
    ];

    useEffect(() => {
        if (!open) {
            return;
        }

        const onPointerDown = (event: MouseEvent) => {
            if (!rootRef.current?.contains(event.target as Node)) {
                onClose();
            }
        };

        const onKeyDown = (event: KeyboardEvent) => {
            if (event.key === 'Escape') {
                onClose();
            }
        };

        document.addEventListener('mousedown', onPointerDown);
        document.addEventListener('keydown', onKeyDown);

        return () => {
            document.removeEventListener('mousedown', onPointerDown);
            document.removeEventListener('keydown', onKeyDown);
        };
    }, [open, onClose]);

    return (
        <div ref={rootRef} className="relative w-80 shrink-0">
            <button
                type="button"
                aria-haspopup="listbox"
                aria-expanded={open}
                aria-label={`配音 ${value.name}`}
                onClick={onToggle}
                className="flex h-16 w-full cursor-pointer items-center justify-between gap-3 rounded-[10px] border-[1.5px] border-cr-accent bg-cr-select px-5"
            >
                <span className="flex min-w-0 items-center gap-2.5 text-[18px] font-bold text-white">
                    <span className="shrink-0">配音</span>
                    <span className="truncate">{value.name}</span>
                </span>
                <ChevronDown
                    size={18}
                    className={`shrink-0 text-white transition-transform duration-200 ${
                        open ? 'rotate-180' : ''
                    }`}
                />
            </button>

            {open ? (
                <div
                    // 菜单向下展开、压在卡片外面。19 项放不下一屏，所以限高可滚
                    role="listbox"
                    aria-label="选择配音"
                    className="absolute top-[72px] left-0 z-20 flex max-h-[420px] w-full flex-col overflow-y-auto rounded-xl border border-cr-menu-border bg-cr-menu p-1.5 shadow-[0_12px_32px_#00000099] scrollbar-ed"
                >
                    {groups.map(({ label, items }) => (
                        <div
                            key={label}
                            role="group"
                            aria-label={label}
                            className="flex flex-col"
                        >
                            <span className="px-3.5 pt-2 pb-1 text-ed-sm text-cr-placeholder">
                                {label}
                            </span>
                            {items.map((option) => {
                                const selected = option.id === value.id;

                                return (
                                    <button
                                        key={option.id}
                                        type="button"
                                        role="option"
                                        aria-selected={selected}
                                        onClick={() => onSelect(option.id)}
                                        className={`flex w-full cursor-pointer items-center justify-between gap-3 rounded-lg px-3.5 py-[7px] text-left ${
                                            selected
                                                ? 'bg-cr-option-active'
                                                : ''
                                        }`}
                                    >
                                        <span className="flex min-w-0 flex-col gap-0.5">
                                            <span
                                                className={`truncate text-[15px] leading-[1.25] text-white ${
                                                    selected ? 'font-bold' : ''
                                                }`}
                                            >
                                                {option.name}
                                            </span>
                                            {/* **每一项都要有说明**：官方只给一部分音色
                                                标了「XX 同款」，光靠那个的话大半行是空的，
                                                列表看着像坏了 */}
                                            <span className="truncate text-ed-base leading-[1.25] text-cr-placeholder">
                                                {option.desc}
                                            </span>
                                        </span>
                                        {selected ? (
                                            <Check
                                                size={16}
                                                className="shrink-0 text-cr-accent"
                                            />
                                        ) : null}
                                    </button>
                                );
                            })}
                        </div>
                    ))}
                </div>
            ) : null}
        </div>
    );
}
