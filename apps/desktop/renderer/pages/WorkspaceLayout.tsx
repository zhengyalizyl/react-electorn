import { useState } from 'react';

import ProjectSidebar from '@/renderer/components/projects/ProjectSidebar';
import type { WorkspaceTab } from '@/renderer/data/project-fixtures';
import CreatePage from '@/renderer/pages/CreatePage';
import ProjectsPage from '@/renderer/pages/ProjectsPage';

/**
 * 工作台：项目与创作在同一个页面里，左侧胶囊导航当 tab 切。
 *
 * 只占一条路由。之前给两个面板各配一条路由，切换时侧栏会被卸载重建，
 * 两团 blur 光晕跟着重新绘制，视觉上闪一下——tab 切换没有这个问题，
 * 侧栏从头到尾就是同一个实例。
 *
 * 代价是「当前在哪个面板」不进 URL，刷新后回到默认的项目面板，
 * 也没法直接深链到创作面板。需要的话可以把 tab 提到 query 参数上。
 */
export default function WorkspaceLayout() {
    const [tab, setTab] = useState<WorkspaceTab>('projects');

    return (
        <div className="flex h-full w-full bg-pj-bg font-ed">
            <ProjectSidebar active={tab} onChange={setTab} />

            {tab === 'projects' ? (
                <ProjectsPage onCreate={() => setTab('create')} />
            ) : (
                <CreatePage />
            )}
        </div>
    );
}
