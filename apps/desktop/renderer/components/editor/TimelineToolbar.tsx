import {
    AudioLines,
    Link,
    Minus,
    Plus,
    Redo2,
    Scissors,
    Undo2,
    WandSparkles
} from 'lucide-react';
import { useCallback } from 'react';

import { formatTimecode } from '@magicut-react-demo/video-project';

import IconButton from '@/renderer/components/editor/IconButton';
import { MAX_PX_PER_MS, MIN_PX_PER_MS } from '@/renderer/data/editor-project';

/**
 * 还做不了的那几颗。
 *
 * 模块级常量：放在组件内部会每次渲染重建数组，
 * 也会让 map 出来的元素每次都是新引用。
 *
 * `blocked` 是**做不了的原因**。留一颗点下去没反应的按钮更糟——
 * 用户会反复点，然后以为程序坏了。
 *
 * 分割不在这里：它已经能用了（schema v2 给配音片段加了源内区间，
 * 切割因此变成纯数据操作，不用去动音频文件）。
 */
const blockedButtons = [
    { Icon: WandSparkles, label: '智能处理', blocked: '智能处理还没接入' },
    { Icon: Link, label: '关联', blocked: '轨道关联还没接入' },
    { Icon: AudioLines, label: '音频', blocked: '音频编辑还没接入' }
] as const;

/** 滑杆一步走多少。按 1/100 分，键盘左右键能做细调 */
const SLIDER_STEPS = 100;
const LN_MIN = Math.log(MIN_PX_PER_MS);
const LN_MAX = Math.log(MAX_PX_PER_MS);

/**
 * 滑杆位置与缩放之间走**对数**映射。
 *
 * 线性映射下，滑杆走前 12% 就把倍率从 1/8 倍翻到 1 倍，剩下 88% 才走完 1→8 倍，
 * 手感完全不可用。缩放这类倍率量必须用对数，每一格才是等比例的。
 *
 * 上下限取成默认值的 1/8 与 8 倍（见 editor-project.ts），
 * 默认值因此正好落在第 50 格上，加减一次能精确回到原位。
 */
function sliderToPxPerMs(step: number): number {
    return Math.exp(LN_MIN + ((LN_MAX - LN_MIN) * step) / SLIDER_STEPS);
}

function pxPerMsToSlider(pxPerMs: number): number {
    const clamped = Math.min(MAX_PX_PER_MS, Math.max(MIN_PX_PER_MS, pxPerMs));
    return Math.round(
        ((Math.log(clamped) - LN_MIN) / (LN_MAX - LN_MIN)) * SLIDER_STEPS
    );
}

interface HistoryProps {
    canUndo?: boolean | undefined;
    canRedo?: boolean | undefined;
    onUndo?: (() => void) | undefined;
    onRedo?: (() => void) | undefined;
    /** 在播放头处切一刀 */
    onSplit?: (() => void) | undefined;
    /** 切不了的原因。有值就置灰并把它写在 title 上 */
    splitBlocked?: string | null | undefined;
}

interface ZoomSliderProps {
    pxPerMs: number;
    onChange: (next: number) => void;
}

function ZoomSlider({ pxPerMs, onChange }: ZoomSliderProps) {
    const step = pxPerMsToSlider(pxPerMs);

    const nudge = useCallback(
        (delta: number) => {
            const next = Math.min(SLIDER_STEPS, Math.max(0, step + delta));
            onChange(sliderToPxPerMs(next));
        },
        [step, onChange]
    );

    return (
        <div className="flex items-center gap-2.5 pl-2.5">
            <IconButton
                icon={Minus}
                label="缩小"
                size={14}
                className="text-ed-text-2"
                onClick={() => nudge(-10)}
            />
            <input
                type="range"
                aria-label="时间线缩放"
                min={0}
                max={SLIDER_STEPS}
                step={1}
                value={step}
                onChange={(event) =>
                    onChange(sliderToPxPerMs(Number(event.target.value)))
                }
                className="zoom-slider h-3 w-16"
            />
            <IconButton
                icon={Plus}
                label="放大"
                size={14}
                className="text-ed-text-2"
                onClick={() => nudge(10)}
            />
        </div>
    );
}

interface TimelineToolbarProps extends HistoryProps {
    durationMs: number;
    pxPerMs: number;
    onPxPerMsChange: (next: number) => void;
}

export default function TimelineToolbar({
    durationMs,
    pxPerMs,
    onPxPerMsChange,
    canUndo = false,
    canRedo = false,
    onUndo,
    onRedo,
    onSplit,
    splitBlocked
}: TimelineToolbarProps) {
    return (
        <div className="flex h-12 shrink-0 items-center justify-between px-7">
            <div className="flex items-center gap-5">
                <h2 className="text-ed-3xl font-bold text-ed-text">时间线</h2>
                <span className="font-ed-mono text-ed-md text-ed-text-2">
                    {/* 总时长由工程算出。写死的话改了分镜这里就是个谎 */}
                    00:00 / {formatTimecode(durationMs)}
                </span>
                {/* 没得撤销时置灰。亮着但点下去没反应，用户只会以为撤销坏了 */}
                <IconButton
                    icon={Undo2}
                    label="撤销"
                    disabled={!canUndo}
                    {...(onUndo ? { onClick: onUndo } : {})}
                    {...(canUndo ? {} : { title: '没有可撤销的操作' })}
                    className="text-ed-text-2 disabled:cursor-not-allowed disabled:opacity-40"
                />
                <IconButton
                    icon={Redo2}
                    label="重做"
                    disabled={!canRedo}
                    {...(onRedo ? { onClick: onRedo } : {})}
                    {...(canRedo ? {} : { title: '没有可重做的操作' })}
                    className="text-ed-text-2 disabled:cursor-not-allowed disabled:opacity-40"
                />
            </div>

            <div className="flex items-center gap-2.5">
                {/*
                    分割：切点就是播放头。切不了时（播放头不在镜头里、
                    太靠边、这一镜有多段配音）置灰并把原因写在 title 上——
                    光灰着一样让人猜。
                */}
                <IconButton
                    icon={Scissors}
                    label="分割"
                    size={14}
                    disabled={onSplit === undefined || Boolean(splitBlocked)}
                    {...(onSplit && !splitBlocked ? { onClick: onSplit } : {})}
                    {...(splitBlocked ? { title: splitBlocked } : {})}
                    className="flex size-[30px] items-center justify-center rounded-md bg-ed-panel-2 text-ed-text disabled:cursor-not-allowed disabled:opacity-40"
                />
                {blockedButtons.map(({ Icon, label, blocked }) => (
                    <IconButton
                        key={label}
                        icon={Icon}
                        label={label}
                        size={14}
                        disabled
                        title={blocked}
                        className="flex size-[30px] items-center justify-center rounded-md bg-ed-panel-2 text-ed-text disabled:cursor-not-allowed disabled:opacity-40"
                    />
                ))}
                <ZoomSlider pxPerMs={pxPerMs} onChange={onPxPerMsChange} />
            </div>
        </div>
    );
}
