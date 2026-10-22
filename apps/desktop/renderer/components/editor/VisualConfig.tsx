import { ArrowDown } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';

import AiMessage from '@/renderer/components/editor/AiMessage';
import Composer from '@/renderer/components/editor/Composer';
import type { ConfigImplementationProps } from '@/renderer/components/editor/ConfigPanel';
import PanelShell from '@/renderer/components/editor/PanelShell';
import SegmentCard from '@/renderer/components/editor/SegmentCard';
import { formatUpdatedAt } from '@/renderer/data/updated-at';

/**
 * 画面模式的配置区，对应设计稿的 Right Panel — 配置区。
 *
 * 有真工程时顶部显示**当前选中那一镜**的实际内容（素材、时长、为什么选它）；
 * 没有工程（`/editor` 无 id 的设计稿预览）时退回设计稿那张静态卡。
 */

/** 离底部还差这么多像素以内，就算"已经在底部了" */
const BOTTOM_SLACK_PX = 24;

export default function VisualConfig({
    project,
    sceneIndex = 0,
    onRequest,
    refine
}: ConfigImplementationProps) {
    const scene = project?.scenes[sceneIndex];

    /**
     * 「回到底部」只在**真的不在底部**时出现。
     *
     * 一直挂在那儿的话，它既是个没用的按钮，又挡着下面的内容——
     * 而用户点下去什么也不会发生（本来就在底部），只会以为是坏的。
     */
    const scrollRef = useRef<HTMLDivElement | null>(null);
    const [atBottom, setAtBottom] = useState(true);

    useEffect(() => {
        const el = scrollRef.current;
        if (!el) return;

        const check = (): void => {
            const distance = el.scrollHeight - el.scrollTop - el.clientHeight;
            setAtBottom(distance <= BOTTOM_SLACK_PX);
        };

        check();
        el.addEventListener('scroll', check, { passive: true });
        return () => el.removeEventListener('scroll', check);
        // 换一镜会换掉卡片内容，高度跟着变，得重新量一次
    }, [sceneIndex, project]);

    const toBottom = (): void => {
        const el = scrollRef.current;
        if (!el) return;
        el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' });
    };

    return (
        <PanelShell label="配置区" scrollRef={scrollRef}>
            <div className="flex w-full justify-end">
                {/* 这一行说的是**这条片子什么时候改的**。
                    设计稿那个「6月10日 17:42」是画稿时的占位，
                    照搬等于在界面上编一个事实 */}
                <span className="text-ed-sm text-ed-text-3">
                    {formatUpdatedAt(project?.project.updatedAt)}
                </span>
            </div>

            {/* 版式照设计稿，内容换成这一镜的真实情况 */}
            <SegmentCard project={project} sceneIndex={sceneIndex} />
            <AiMessage
                notes={project?.ai.notes}
                decisions={project?.ai.decisions}
            />

            {atBottom ? null : (
                <div className="flex w-full justify-center">
                    <button
                        type="button"
                        onClick={toBottom}
                        className="flex cursor-pointer items-center gap-1.5 rounded-full border border-ed-border bg-ed-panel-2 px-3.5 py-1.5"
                    >
                        <ArrowDown size={12} className="text-ed-text-2" />
                        <span className="text-ed-sm text-ed-text">
                            回到底部
                        </span>
                    </button>
                </div>
            )}

            {/* 快捷调整的胶囊跟着左边选中的分镜走——
                写死成「分镜 01」的话，用户选了第 2 镜提要求，改的却是第 1 镜 */}
            <Composer
                sceneLabel={
                    scene
                        ? `分镜 ${String(sceneIndex + 1).padStart(2, '0')}`
                        : undefined
                }
                {...(onRequest ? { onSubmit: onRequest } : {})}
                recorded={
                    project?.ai.requests.filter(
                        (item) => item.sceneId === scene?.id
                    ).length ?? 0
                }
                busy={refine?.busy ?? false}
                status={refine?.stage ?? null}
                error={refine?.error ?? null}
            />
        </PanelShell>
    );
}
