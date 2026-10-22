import { Scissors } from 'lucide-react';

import PillNav from '@/renderer/components/projects/PillNav';
import type { WorkspaceTab } from '@/renderer/data/project-fixtures';

interface ProjectSidebarProps {
    active: WorkspaceTab;
    onChange: (tab: WorkspaceTab) => void;
}

/**
 * 项目页侧栏。
 *
 * 两团光晕在设计稿里是带 blur 的径向渐变椭圆，用绝对定位 + blur 还原。
 * 它们纯装饰，aria-hidden 且 pointer-events-none，不挡下面的导航。
 */
export default function ProjectSidebar({
    active,
    onChange
}: ProjectSidebarProps) {
    return (
        <aside
            aria-label="侧栏"
            className="relative flex w-[295px] shrink-0 flex-col overflow-hidden border-r border-pj-border bg-pj-sidebar"
        >
            <span
                aria-hidden="true"
                className="pointer-events-none absolute -top-[200px] -left-40 h-[520px] w-[420px] rounded-full blur-[70px]"
                style={{
                    background:
                        'radial-gradient(closest-side, #2FE3A8AA 0%, #3B6BFF66 50%, #07070D00 100%)'
                }}
            />
            <span
                aria-hidden="true"
                className="pointer-events-none absolute top-[560px] -left-[60px] h-[420px] w-[300px] rounded-full blur-[60px]"
                style={{
                    background:
                        'radial-gradient(closest-side, #B23BFF88 0%, #FF4FB544 50%, #07070D00 100%)'
                }}
            />

            <div className="relative flex items-center gap-3 px-[18px] pt-5">
                <span className="flex size-13 items-center justify-center rounded-[14px] bg-linear-135 from-[#7C5CFF] to-[#3B8BFF]">
                    <Scissors size={26} className="text-white" />
                </span>
                <span className="flex flex-col gap-0.5">
                    <span className="text-[24px] font-bold text-white">
                        妙剪 Magicut
                    </span>
                    <span className="text-ed-sm text-ed-text-2">
                        智能视频剪辑工具
                    </span>
                </span>
            </div>

            {/* 设计稿把胶囊定位在 y=380，占页面中下部；这里用 flex 居中，
                窗口高度变化时不会被钉死在某个绝对坐标上 */}
            <div className="relative flex flex-1 items-center pl-[27px]">
                <PillNav active={active} onChange={onChange} />
            </div>
        </aside>
    );
}
