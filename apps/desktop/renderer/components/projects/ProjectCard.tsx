import { Trash2 } from 'lucide-react';

import IconButton from '@/renderer/components/editor/IconButton';
import { coverFallback } from '@/renderer/data/project-fixtures';

/**
 * 卡片的视图模型。
 *
 * 刻意**不是** `ProjectSummary`：卡片要的是格式化好的时间与封面配色，
 * 而 summary 上是 ISO 时间串。把格式化塞进卡片会让它被迫认识工程的数据结构。
 */
export interface ProjectCardView {
    id: string;
    title: string;
    /** 已格式化，形如 `创建时间 2026-09-23` */
    createdAt: string;
    fallback: readonly [string, string];
    /** 真实工程没有封面图（P1 不做抽帧封面），只有兜底渐变 */
    cover?: string;
}

interface ProjectCardProps {
    project: ProjectCardView;
    onOpen: (id: string) => void;
    onDelete: (id: string) => void;
}

/**
 * 项目卡。
 *
 * 设计稿里第一张卡描边更亮、带紫色外发光，其余没有——读作悬停态的示意，
 * 所以这里做成所有卡的 hover/focus 效果，而不是把第一张钉死成特例。
 *
 * 删除按钮是卡片内的独立按钮，不能嵌在打开项目的按钮里：button 套 button
 * 是非法结构，键盘和读屏都会出问题。所以整卡用 article + 内部一个打开按钮。
 */
export default function ProjectCard({
    project,
    onOpen,
    onDelete
}: ProjectCardProps) {
    return (
        <article className="group flex h-[288px] w-[353px] shrink-0 flex-col overflow-hidden rounded-[18px] border border-pj-card-border bg-pj-card transition-[border-color,box-shadow] duration-200 hover:border-pj-card-border-hover hover:shadow-[0_0_30px_#7B5CFF55] focus-within:border-pj-card-border-hover focus-within:shadow-[0_0_30px_#7B5CFF55]">
            <button
                type="button"
                aria-label={`打开项目 ${project.title}`}
                onClick={() => onOpen(project.id)}
                className="h-[150px] w-full shrink-0 cursor-pointer"
                style={{ background: coverFallback(project.fallback) }}
            >
                {project.cover ? (
                    <img
                        src={project.cover}
                        alt=""
                        className="size-full object-cover"
                        // 图挂了就让兜底渐变露出来，而不是显示破图图标
                        onError={(event) => {
                            event.currentTarget.style.display = 'none';
                        }}
                    />
                ) : null}
            </button>

            <div className="flex flex-1 flex-col gap-3.5 px-[22px] py-[18px]">
                <h3 className="w-full text-[19px] leading-[1.35] font-bold text-white">
                    {project.title}
                </h3>
                <div className="mt-auto flex w-full items-center justify-between">
                    <span className="text-ed-md text-pj-text-2">
                        {project.createdAt}
                    </span>
                    <IconButton
                        icon={Trash2}
                        label={`删除项目 ${project.title}`}
                        size={18}
                        onClick={() => onDelete(project.id)}
                        className="text-pj-text-2 transition-colors duration-150 hover:text-white"
                    />
                </div>
            </div>
        </article>
    );
}
