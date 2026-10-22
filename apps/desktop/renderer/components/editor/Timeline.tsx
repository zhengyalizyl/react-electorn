import { useMemo, useState } from 'react';

import type { VideoProject } from '@magicut-react-demo/video-project';
import { projectToTimelineView } from '@magicut-react-demo/video-project';

import TimelineToolbar from '@/renderer/components/editor/TimelineToolbar';
import {
    TrackLabels,
    TrackLanes
} from '@/renderer/components/editor/TimelineTracks';
import {
    DEFAULT_PX_PER_MS,
    editorProject
} from '@/renderer/data/editor-project';

interface TimelineProps {
    /** 真实工程。不传就用示例工程——`/editor` 无 id 时是设计稿预览 */
    project?: VideoProject | undefined;
    /** 播放头，毫秒。由页面持有的那个时钟给，和预览区是同一个 */
    timeMs?: number | undefined;
    /** 正在播时才自动把播放头滚进视野——手动拖看别处时不该被拽回去 */
    playing?: boolean | undefined;
    /** 点轨道区跳到那个时间。不传就不给点 */
    onSeek?: ((timeMs: number) => void) | undefined;
    /** 鼠标停在哪个时刻。null = 没在时间线上 */
    hoverMs?: number | null | undefined;
    /** 鼠标移动/移开。移开时给 null，预览要还原 */
    onHover?: ((timeMs: number | null) => void) | undefined;
    /**
     * 撤销 / 重做。
     *
     * 历史由**页面**持有，不在时间线里：能撤销的是整页的编辑（眼下是字幕样式），
     * 不是时间线自己的事。按钮长在工具条上只是位置问题。
     */
    canUndo?: boolean | undefined;
    canRedo?: boolean | undefined;
    onUndo?: (() => void) | undefined;
    onRedo?: (() => void) | undefined;
    /** 在播放头处切一刀 */
    onSplit?: (() => void) | undefined;
    /** 切不了的原因。有值就置灰并把它写在 title 上 */
    splitBlocked?: string | null | undefined;
}

export default function Timeline({
    project,
    timeMs = 0,
    playing = false,
    hoverMs = null,
    onSeek,
    onHover,
    canUndo,
    canRedo,
    onUndo,
    onRedo,
    onSplit,
    splitBlocked
}: TimelineProps) {
    // 缩放是时间线的局部状态：只有这棵子树关心它，提到页面级没有收益
    const [pxPerMs, setPxPerMs] = useState(DEFAULT_PX_PER_MS);

    // 投影是纯函数，但 9 个分镜 × 四条轨道每次渲染重算没必要；
    // editorProject 是模块级单例，依赖项稳定，缓存才生效
    const source = project ?? editorProject;
    const view = useMemo(
        () => projectToTimelineView(source, pxPerMs),
        [source, pxPerMs]
    );

    return (
        <section
            aria-label="时间线"
            className="flex h-[314px] shrink-0 flex-col overflow-hidden border-t border-ed-border bg-ed-bg"
        >
            <TimelineToolbar
                durationMs={view.durationMs}
                pxPerMs={pxPerMs}
                onPxPerMsChange={setPxPerMs}
                canUndo={canUndo ?? false}
                canRedo={canRedo ?? false}
                {...(onUndo ? { onUndo } : {})}
                {...(onRedo ? { onRedo } : {})}
                {...(onSplit ? { onSplit } : {})}
                splitBlocked={splitBlocked ?? null}
            />

            {/*
                轨道数由工程决定（这里是四条），超出高度就整体纵向滚动。
                滚动必须加在**同时包住标签列与轨道列**的容器上，
                分开滚会让标签与轨道错位。
            */}
            <div className="relative flex min-h-0 flex-1 overflow-y-auto scrollbar-ed">
                <TrackLabels view={view} />
                {/*
                    播放头画在 TrackLanes **里面**。放在外层的话横向滚动时它不动，
                    一滚就和片段错开——那比没有播放头更容易骗人。
                */}
                <TrackLanes
                    view={view}
                    pxPerMs={pxPerMs}
                    timeMs={timeMs}
                    playing={playing}
                    hoverMs={hoverMs}
                    {...(onSeek ? { onSeek } : {})}
                    {...(onHover ? { onHover } : {})}
                />
            </div>
        </section>
    );
}
