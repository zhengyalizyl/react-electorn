import { useEffect, useMemo, useRef } from 'react';

import type { VideoProject } from '@magicut-react-demo/video-project';
import { formatRange, formatTimecode } from '@magicut-react-demo/video-project';

import {
    CurrentShotCard,
    IdleShotCard
} from '@/renderer/components/editor/ShotCard';
import {
    CURRENT_SCENE_INDEX,
    editorProject
} from '@/renderer/data/editor-project';

interface ScriptSidebarProps {
    /** 真实工程。不传就用示例工程——`/editor` 无 id 时是设计稿预览 */
    project?: VideoProject | undefined;
    /**
     * 当前选中的分镜序号。
     *
     * 之前这里是个写死的常量（`CURRENT_SCENE_INDEX`），所以卡片看着能点、
     * 点了没反应。现在由编辑器持有，侧栏、预览、右侧配置区共用同一个值。
     */
    current?: number | undefined;
    onSelect?: ((index: number) => void) | undefined;
}

export default function ScriptSidebar({
    project,
    current: currentIndex,
    onSelect
}: ScriptSidebarProps) {
    const source = project ?? editorProject;

    // 分镜卡片由 project.scenes 投影而来。时间区间从 startMs/durationMs 算，
    // 不再是写死的字符串
    const shots = useMemo(() => {
        /**
         * `ai.decisions` → 每一镜的「为什么选这个片段」。
         *
         * plan.md §7.1 把它定成必须项而不是可选项：界面上看到不合理的结果时，
         * 没有这条就无从调试，用户也没法给反馈。所以它要真的显示出来，
         * 而不是只躺在 JSON 里。
         */
        const reasonByScene = new Map<string, string>();
        for (const decision of source.ai.decisions) {
            if (decision.sceneId && !reasonByScene.has(decision.sceneId)) {
                reasonByScene.set(decision.sceneId, decision.reason);
            }
        }

        return source.scenes.map((scene) => ({
            id: scene.id,
            index: scene.index,
            label: `分镜 ${String(scene.index + 1).padStart(2, '0')}`,
            time: formatRange(scene.startMs, scene.durationMs),
            script: scene.script,
            reason: reasonByScene.get(scene.id as string)
        }));
    }, [source]);

    // 没传就退回设计稿那个常量——`/editor` 无 id 时是纯预览，没人来选
    const activeIndex = currentIndex ?? CURRENT_SCENE_INDEX;
    const current = shots.find((shot) => shot.index === activeIndex);

    /**
     * 当前分镜滚进可视区。
     *
     * 播放推进到第 7 镜时，如果它在滚动条以下，界面上就是"没有任何一镜高亮"——
     * 用户看不出播到哪了，只会以为高亮坏了。
     *
     * `block: 'nearest'` 而不是 `'center'`：已经在视野里就不动。
     * 每次换镜都把列表居中一次，读起来很晕。
     */
    const activeRef = useRef<HTMLLIElement | null>(null);
    useEffect(() => {
        activeRef.current?.scrollIntoView({ block: 'nearest' });
    }, [activeIndex]);

    return (
        <aside
            aria-label="文稿字幕"
            className="flex w-[310px] shrink-0 flex-col gap-3 overflow-hidden border-r border-ed-border bg-ed-bg px-3.5 pt-5 pb-4"
        >
            <div className="flex flex-col gap-1 px-3 pb-1.5">
                <h2 className="text-ed-3xl font-bold text-ed-text">文稿字幕</h2>
                <p className="text-ed-sm text-ed-text-2">
                    {/* 段数与总时长都按数据算。设计稿那句写的是「8 段分镜 · 00:30」，
                        与内容本来就对不上 */}
                    {shots.length} 段分镜 ·{' '}
                    {formatTimecode(source.canvas.durationMs)}
                    {current ? ` · 当前 ${current.time}` : ''}
                </p>
            </div>

            {/*
                **分镜多了要能上下滚。** 少了 `flex-1` 的话这个 ul 只占内容高度，
                外层又是 `overflow-hidden`，于是超出的分镜直接被裁掉——
                看上去就是"后面几镜不见了"，而且没有任何可滚的迹象。
            */}
            <ul className="flex min-h-0 flex-1 flex-col gap-1.5 overflow-y-auto scrollbar-ed">
                {shots.map((shot) => (
                    <li
                        key={shot.id}
                        ref={shot.index === activeIndex ? activeRef : undefined}
                    >
                        {shot.index === activeIndex ? (
                            <CurrentShotCard
                                shot={shot}
                                onSelect={() => onSelect?.(shot.index)}
                            />
                        ) : (
                            <IdleShotCard
                                shot={shot}
                                onSelect={() => onSelect?.(shot.index)}
                            />
                        )}
                    </li>
                ))}
            </ul>
        </aside>
    );
}
