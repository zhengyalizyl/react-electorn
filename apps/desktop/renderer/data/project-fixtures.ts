// 本文件的内容逐字取自 magicut-demo.pen 的 frame tr9ry（妙剪 Magicut — 项目页）。
// 接真实项目数据前整体替换。

// 占位项目已删除：列表改由主进程扫 project.json 得到真实数据（plan.md §9.1）。

/** 工作台里可切换的两个面板 */
export type WorkspaceTab = 'create' | 'projects';

/**
 * 侧栏胶囊导航。
 *
 * 项目与创作在同一个页面里用 tab 切换，不各占一条路由——切路由会让侧栏
 * 连同两团 blur 光晕重新挂载，视觉上闪一下。
 *
 * 首页还没有对应实现，tab 为 null 时渲染成禁用项。
 */
export interface NavItem {
    id: string;
    label: string;
    icon: 'house' | 'scissors' | 'folder';
    tab: WorkspaceTab | null;
}

export const navItems = [
    { id: 'nav-home', label: '首页', icon: 'house', tab: null },
    { id: 'nav-create', label: '创作', icon: 'scissors', tab: 'create' },
    { id: 'nav-projects', label: '项目', icon: 'folder', tab: 'projects' }
] as const satisfies readonly NavItem[];

export const SECTION_TITLE = '所有项目';

export const SECTION_CAPTION = '创建、查看和继续编辑你的智能视频项目';

export function coverFallback([from, to]: readonly [string, string]): string {
    return `linear-gradient(135deg, ${from} 0%, ${to} 100%)`;
}
