import { Folder, House, Scissors } from 'lucide-react';

import type { NavItem, WorkspaceTab } from '@/renderer/data/project-fixtures';
import { navItems } from '@/renderer/data/project-fixtures';

const icons = {
    house: House,
    scissors: Scissors,
    folder: Folder
};

function NavBody({ item, active }: { item: NavItem; active: boolean }) {
    const Icon = icons[item.icon];

    return (
        <>
            <span
                className={`flex size-12 items-center justify-center rounded-full ${
                    active ? 'bg-white/15' : 'bg-pj-icon'
                }`}
            >
                <Icon
                    size={20}
                    className={active ? 'text-white' : 'text-pj-nav-text'}
                />
            </span>
            <span
                className={`text-ed-md ${
                    active ? 'font-bold text-white' : 'text-pj-nav-text'
                }`}
            >
                {item.label}
            </span>
        </>
    );
}

interface PillNavProps {
    active: WorkspaceTab;
    onChange: (tab: WorkspaceTab) => void;
}

/**
 * 侧栏的胶囊导航，同时也是工作台的 tab 栏。
 *
 * 选中项在设计稿里是 112×112 的渐变圆 + 紫色外发光，未选中是 80×80 无底色。
 *
 * 用 tablist/tab 语义而不是链接：项目与创作是同一个页面里的两个面板，
 * 不走路由，读屏也应当听到「选项卡 2 之 2」而不是「链接」。
 * 首页还没有实现，渲染成禁用项——做成看起来能点、点了没反应的东西更糟。
 */
export default function PillNav({ active, onChange }: PillNavProps) {
    return (
        <div
            role="tablist"
            aria-label="主导航"
            aria-orientation="vertical"
            className="flex w-[133px] flex-col items-center justify-center gap-[26px] rounded-[66px] border border-pj-pill-border bg-pj-pill py-6"
        >
            {navItems.map((item) => {
                if (!item.tab) {
                    return (
                        <button
                            key={item.id}
                            type="button"
                            disabled
                            aria-label={`${item.label}（暂未实现）`}
                            className="flex size-20 cursor-not-allowed flex-col items-center justify-center gap-2.5 rounded-full opacity-60"
                        >
                            <NavBody item={item} active={false} />
                        </button>
                    );
                }

                const selected = item.tab === active;

                return (
                    <button
                        key={item.id}
                        type="button"
                        role="tab"
                        aria-selected={selected}
                        aria-controls={`workspace-panel-${item.tab}`}
                        onClick={() => onChange(item.tab)}
                        className={`flex cursor-pointer flex-col items-center justify-center rounded-full transition-[width,height] duration-200 ${
                            selected
                                ? 'size-28 gap-1.5 bg-linear-200 from-[#8A5CFF] from-0% via-[#E44FCF] via-55% to-[#FF6FA3] to-100% shadow-[0_0_40px_6px_#C24FE0AA]'
                                : 'size-20 gap-2.5'
                        }`}
                    >
                        <NavBody item={item} active={selected} />
                    </button>
                );
            })}
        </div>
    );
}
