import { useMemo } from 'react';
import { useNavigate } from 'react-router-dom';

import DotField from '@/renderer/components/DotField';
import NewProjectCard from '@/renderer/components/projects/NewProjectCard';
import type { ProjectCardView } from '@/renderer/components/projects/ProjectCard';
import ProjectCard from '@/renderer/components/projects/ProjectCard';
import {
    SECTION_CAPTION,
    SECTION_TITLE
} from '@/renderer/data/project-fixtures';
import {
    coverFor,
    formatCreatedAt,
    useProjects
} from '@/renderer/data/use-projects';

interface ProjectsPageProps {
    /** 点「新建」时切到创作页。由 WorkspaceLayout 传入 */
    onCreate?: () => void;
}

/**
 * 项目页。
 *
 * 对应 magicut-demo.pen 的 frame tr9ry（妙剪 Magicut — 项目页）。
 *
 * **列表是真实数据**：主进程扫工程目录读 `project.json`（plan.md §9.1）。
 * 设计稿里那两张卡是占位，已经去掉。
 */
export default function ProjectsPage({ onCreate }: ProjectsPageProps) {
    const navigate = useNavigate();
    const { state, remove } = useProjects();

    const cards = useMemo<ProjectCardView[]>(() => {
        if (state.status !== 'ready') return [];
        return state.projects.map((project) => ({
            id: project.dirName,
            title: project.title,
            createdAt: formatCreatedAt(project.createdAt),
            fallback: coverFor(project.id)
        }));
    }, [state]);

    return (
        // 侧栏由 WorkspaceLayout 提供，这里只负责右侧内容区。
        // isolate 建一个新的层叠上下文，背景的 -z-10 不会穿到布局外面去
        <main
            id="workspace-panel-projects"
            role="tabpanel"
            aria-label="所有项目"
            className="relative isolate flex min-w-0 flex-1 flex-col gap-5 overflow-y-auto px-[98px] pt-[196px] scrollbar-ed"
        >
            {/* 铺满内容区并垫在最底层。
                DotField 由 `pnpm dlx shadcn@latest add @react-bits/DotField-JS-CSS`
                装入 components/DotField.jsx，是第三方组件，不要手改——升级会被覆盖。
                aria-hidden 与 pointer-events-none 加在这层外壳上：它是纯装饰，
                既不该被读屏念出来，也不能拦住下面卡片的点击。 */}
            <div
                aria-hidden="true"
                className="pointer-events-none absolute inset-0 -z-10"
            >
                <DotField
                    gradientFrom="rgba(138, 92, 255, 0.34)"
                    gradientTo="rgba(228, 79, 207, 0.20)"
                    glowColor="#221436"
                />
            </div>
            <div className="contents">
                <div className="flex flex-col gap-1.5">
                    <h1 className="text-[28px] font-bold text-white">
                        {SECTION_TITLE}
                    </h1>
                    <p className="text-ed-md text-pj-text-2">
                        {SECTION_CAPTION}
                    </p>
                </div>

                <div className="flex flex-wrap items-start gap-6">
                    <NewProjectCard onCreate={() => onCreate?.()} />

                    {cards.map((project) => (
                        <ProjectCard
                            key={project.id}
                            project={project}
                            onOpen={(id) => navigate(`/editor/${id}`)}
                            onDelete={(id) => void remove(id)}
                        />
                    ))}

                    {/* 四种状态各有各的话要说。
                        「没有桥」与「一个项目都没有」对用户的含义完全不同，
                        统一显示空态会让人在浏览器里以为自己的项目丢了 */}
                    {state.status !== 'ready' || cards.length === 0 ? (
                        <p className="flex h-[288px] items-center text-ed-md text-pj-text-2">
                            {state.status === 'loading'
                                ? '正在读取项目…'
                                : state.status === 'unavailable'
                                  ? '项目列表只在桌面端可用'
                                  : state.status === 'failed'
                                    ? `读取项目失败：${state.message}`
                                    : '还没有项目，点左边创建一个吧'}
                        </p>
                    ) : null}
                </div>
            </div>
        </main>
    );
}
