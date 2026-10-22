import { Check } from 'lucide-react';

import { findVoice } from '@magicut-react-demo/video-agent/voices';

/**
 * 跑完之后的视频概览（设计稿 W8bPLG 的「视频概览」+「制作完成状态条」）。
 *
 * ## 四个指标只放拿得出真值的
 *
 * 稿子上是「成片时长 / 视频风格 / 口播音色 / 导出状态」。其中两个我们填不了：
 *
 * - **视频风格**（「科技蓝紫 MG 动画」）：图根本不产出风格标签，编一个填进去，
 *   用户会以为系统真按那个风格做了
 * - **成片时长**：时长在落盘的工程里，渲染层手上没有；为了凑一个数字去读文件，
 *   不如换成手边就有的真数
 *
 * 换成**分镜数**与**素材命中**——图真产出了几段、几段配上了素材，都是查得到的。
 *
 * 导出状态写「工程已保存」而不是「已导出」：**创作这一步确实只落盘，不渲染。**
 * 渲染导出是编辑器里那颗按钮的事，用户要先看过片子再决定导不导。
 * （ffmpeg 渲染本身已经接上了，别因为这行字以为还没有。）
 */

interface OverviewCardProps {
    sceneCount: number;
    /** 配上素材的分镜数 */
    matched: number;
    voiceId: string | null;
    onOpenProject: () => void;
}

function Metric({
    label,
    value,
    tone
}: {
    label: string;
    value: string;
    tone: string;
}) {
    return (
        <div className="flex flex-1 flex-col gap-1.5 rounded-[10px] border border-msg-border bg-msg-metric p-3">
            <span className="text-ed-sm text-msg-text-4">{label}</span>
            <span className={`truncate text-ed-md font-bold ${tone}`}>
                {value}
            </span>
        </div>
    );
}

export default function OverviewCard({
    sceneCount,
    matched,
    voiceId,
    onOpenProject
}: OverviewCardProps) {
    const voice = voiceId === null ? undefined : findVoice(voiceId);

    return (
        <section aria-label="视频概览" className="flex w-full flex-col gap-3">
            <h3 className="text-ed-xl font-bold text-msg-text">视频概览</h3>

            <div className="flex w-full gap-2.5">
                <Metric
                    label="分镜数"
                    value={`${sceneCount} 段`}
                    tone="text-msg-blue"
                />
                <Metric
                    label="素材命中"
                    value={`${matched}/${sceneCount} 段`}
                    tone="text-msg-purple"
                />
                <Metric
                    label="口播音色"
                    value={voice?.name ?? '默认音色'}
                    tone="text-msg-done"
                />
                {/* 创作这一步只落盘不渲染——导出是编辑器里那颗按钮的事。
                    写「已导出」会让用户去找一个根本不存在的 mp4 */}
                <Metric
                    label="导出状态"
                    value="工程已保存"
                    tone="text-msg-running"
                />
            </div>

            <div className="flex w-full items-center justify-between gap-3 rounded-[10px] border border-msg-ok-border bg-msg-ok-bg px-3 py-2.5">
                <span className="flex items-center gap-2">
                    <Check size={18} className="shrink-0 text-msg-done" />
                    <span className="text-ed-md font-semibold text-msg-ok-text">
                        视频制作完成，可进入编辑器预览并微调轨道。
                    </span>
                </span>

                <button
                    type="button"
                    onClick={onOpenProject}
                    className="h-9 shrink-0 cursor-pointer rounded-lg border border-msg-ok-border px-4 text-ed-md font-bold text-msg-ok-text"
                >
                    去项目列表
                </button>
            </div>
        </section>
    );
}
