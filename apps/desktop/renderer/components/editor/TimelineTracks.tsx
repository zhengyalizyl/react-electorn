import { Captions, Clapperboard, Mic, Music } from 'lucide-react';
import type { MouseEvent, ReactNode, RefObject } from 'react';
import { memo, useEffect, useRef } from 'react';

import type {
    TimelineClipView,
    TimelineTrackView,
    TimelineView
} from '@magicut-react-demo/video-project';

import {
    thumbCountFor,
    videoPaletteFor,
    waveformBars
} from '@/renderer/data/track-palette';

/** 轨道种类 → 图标与显示名。工程里的轨道顺序决定显示顺序，这里只提供外观 */
const trackChrome = {
    video: { Icon: Clapperboard, name: '视频 1' },
    voice: { Icon: Mic, name: '配音' },
    subtitle: { Icon: Captions, name: '字幕' },
    music: { Icon: Music, name: '音乐' }
} as const;

const rulerSpacer = <div className="h-7" />;

/**
 * 一条轨道的容器。
 *
 * 片段用**绝对定位**，位置来自投影出的 `leftPx`——不是用 flex 顺序排。
 * 顺序排的话，片段之间的空洞就没法表达，而空洞在真实工程里是合法的
 * （字幕轨两句之间本来就有间隔）。
 */
function Lane({ children }: { children: ReactNode }) {
    // 宽度由外层那个"至少一屏"的容器决定，这里跟满即可
    return <div className="relative h-11 w-full shrink-0">{children}</div>;
}

function clipBox(clip: TimelineClipView) {
    return { left: clip.leftPx, width: clip.widthPx };
}

function VideoClip({ clip }: { clip: TimelineClipView }) {
    const palette = videoPaletteFor(clip.sceneIndex);
    return (
        <div
            style={{
                ...clipBox(clip),
                backgroundColor: palette.bg,
                borderColor: palette.border
            }}
            className="absolute top-0 flex h-11 items-center gap-2 overflow-hidden rounded-md border pr-2.5"
        >
            <span
                style={{ backgroundColor: palette.edge }}
                className="h-5 w-[3px] shrink-0 rounded-[2px]"
            />
            <span className="text-ed-md font-bold whitespace-nowrap text-ed-text">
                {clip.label}
            </span>
            {Array.from({ length: thumbCountFor(clip.widthPx) }, (_, i) => (
                <span
                    key={i}
                    className="h-5 w-7 shrink-0 rounded bg-white/12"
                />
            ))}
        </div>
    );
}

function VoiceClip({ clip }: { clip: TimelineClipView }) {
    return (
        <div
            style={clipBox(clip)}
            className="absolute top-0 flex h-11 items-center gap-3.5 overflow-hidden rounded-md border border-[#1C7A57] bg-[#0E3D2C] px-3"
        >
            <span className="text-ed-md whitespace-nowrap text-ed-text">
                {clip.label}
            </span>
            <div className="flex h-6 items-center gap-[3px]">
                {waveformBars(clip.id, clip.widthPx).map((height, i) => (
                    <span
                        key={i}
                        style={{ height }}
                        className="w-0.5 shrink-0 rounded-[1px] bg-[#3DDC97]"
                    />
                ))}
            </div>
        </div>
    );
}

function SubtitleClip({ clip }: { clip: TimelineClipView }) {
    return (
        <div
            style={clipBox(clip)}
            className="absolute top-0 flex h-11 items-center gap-2 overflow-hidden rounded-md border border-[#B9761E] bg-[#5E3A10] px-2.5"
            title={clip.label}
        >
            <Captions size={14} className="shrink-0 text-[#F0B860]" />
            <span className="truncate text-ed-md text-ed-text">
                {clip.label}
            </span>
        </div>
    );
}

function MusicClip({ clip }: { clip: TimelineClipView }) {
    return (
        <div
            style={clipBox(clip)}
            className="absolute top-0 flex h-11 items-center gap-2 overflow-hidden rounded-md border border-[#3F5BA8] bg-[#1B2647] px-2.5"
        >
            <Music size={14} className="shrink-0 text-[#7E9BFF]" />
            <span className="truncate text-ed-md text-ed-text">
                {clip.label}
            </span>
        </div>
    );
}

const ClipOf = memo(function ClipOf({ clip }: { clip: TimelineClipView }) {
    switch (clip.kind) {
        case 'video':
            return <VideoClip clip={clip} />;
        case 'voice':
            return <VoiceClip clip={clip} />;
        case 'subtitle':
            return <SubtitleClip clip={clip} />;
        case 'music':
            return <MusicClip clip={clip} />;
        default:
            return null;
    }
});

/** 轨道说明文字。片段数从数据来，写死的话增删片段就会对不上 */
function captionOf(track: TimelineTrackView): string {
    return `${track.clips.length} 个片段`;
}

export const TrackLabels = memo(function TrackLabels({
    view
}: {
    view: TimelineView;
}) {
    return (
        <div className="flex w-[215px] shrink-0 flex-col gap-8 pl-7">
            {rulerSpacer}
            {view.tracks.map((track) => {
                const { Icon, name } = trackChrome[track.kind];
                return (
                    <div
                        key={track.id}
                        className="flex h-11 shrink-0 items-center gap-3"
                    >
                        <Icon size={16} className="shrink-0 text-ed-text-2" />
                        <div className="flex flex-col gap-[3px]">
                            <span className="text-ed-md text-ed-text">
                                {name}
                            </span>
                            <span className="text-ed-xs text-ed-text-3">
                                {captionOf(track)}
                            </span>
                        </div>
                    </div>
                );
            })}
        </div>
    );
});

const TimeRuler = memo(function TimeRuler({ view }: { view: TimelineView }) {
    return (
        <div className="relative h-7 w-full shrink-0">
            {view.ruler.marks.map((mark) => (
                <div
                    key={mark.atMs}
                    style={{ left: mark.leftPx }}
                    className="absolute bottom-0 flex flex-col gap-1"
                >
                    <span className="h-1.5 w-px bg-ed-text-3" />
                    <span className="font-ed-mono text-ed-xs text-ed-text-3">
                        {mark.label}
                    </span>
                </div>
            ))}
        </div>
    );
});

/**
 * 播放头跟着播放进度走。
 *
 * 画在轨道内容**里面**，所以横向滚动时它和片段一起走；
 * 画在外面的话一滚就错位，比没有播放头更容易骗人。
 */
function Playhead({
    leftPx,
    hover = false
}: {
    leftPx: number;
    /** 悬停头：跟着鼠标走的那条，要和真正的播放头区分得开 */
    hover?: boolean;
}) {
    return (
        <div
            aria-hidden="true"
            data-testid={hover ? 'hover-playhead' : 'playhead'}
            style={{
                // **用 transform 而不是 left。** 播放时这个值每帧都在变，
                // 写 left 会触发布局与重绘；translateX 交给合成器，不参与布局。
                // 这是"移动得平不平滑"的关键——每秒改 60 次 left 的线，
                // 在内容多的时间线上会肉眼可见地顿
                transform: `translateX(${leftPx}px)`,
                willChange: 'transform'
            }}
            className="pointer-events-none absolute top-0 left-0 h-full w-3"
        >
            <span
                className={`absolute top-0 left-[1px] h-full w-0.5 ${
                    hover ? 'bg-ed-text-3' : 'bg-ed-accent'
                }`}
            />
            <span
                className={`absolute top-0.5 left-[-3px] size-2.5 rounded-full ${
                    hover ? 'bg-ed-text-3' : 'bg-ed-accent'
                }`}
            />
        </div>
    );
}

/**
 * 播放时把播放头滚进视野。
 *
 * **只在播放时**滚：手动拖到别处看片段的时候被一次次拽回去，比不自动滚更烦。
 * 已经在视野里就不动——每帧都 `scrollTo` 会让整条轨道抖。
 */
/**
 * 把播放头滚进视野。
 *
 * 两种情况要滚，理由不一样：
 *
 * 1. **播放中**——播放头一直在走，不滚就会走出屏幕
 * 2. **跳转**（点左侧分镜、点时间线）——用户明确要看那个位置
 *
 * 暂停时的连续小位移不滚：那是用户自己在拖，被一次次拽回去比不自动滚更烦。
 * 靠"这一次挪了多远"区分跳转与连续播放——一帧走不了那么远。
 */
const JUMP_PX = 40;

function useFollowPlayhead(
    ref: RefObject<HTMLDivElement | null>,
    leftPx: number,
    playing: boolean
): void {
    const previous = useRef(leftPx);

    useEffect(() => {
        const el = ref.current;
        const jumped = Math.abs(leftPx - previous.current) > JUMP_PX;
        previous.current = leftPx;
        if (!el || (!playing && !jumped)) return;

        const margin = 80;
        if (leftPx < el.scrollLeft + margin) {
            el.scrollLeft = Math.max(0, leftPx - margin);
        } else if (leftPx > el.scrollLeft + el.clientWidth - margin) {
            el.scrollLeft = leftPx - el.clientWidth + margin;
        }
    }, [ref, leftPx, playing]);
}

export function TrackLanes({
    view,
    pxPerMs,
    timeMs,
    playing,
    hoverMs,
    onSeek,
    onHover
}: {
    view: TimelineView;
    pxPerMs: number;
    timeMs: number;
    playing: boolean;
    /** 鼠标停在哪个时刻。null = 没在时间线上 */
    hoverMs?: number | null | undefined;
    /** 点某个位置 = 把播放时间设到那儿 */
    onSeek?: ((timeMs: number) => void) | undefined;
    /** 鼠标移动/移开。移开时给 null，预览要还原 */
    onHover?: ((timeMs: number | null) => void) | undefined;
}) {
    const scrollRef = useRef<HTMLDivElement | null>(null);
    const leftPx = timeMs * pxPerMs;
    useFollowPlayhead(scrollRef, leftPx, playing);

    /** 鼠标在内容里的横坐标 → 时刻。夹在片长之内，别让人划出片尾 */
    const timeAt = (event: MouseEvent<HTMLDivElement>): number => {
        const rect = event.currentTarget.getBoundingClientRect();
        const raw = (event.clientX - rect.left) / pxPerMs;
        return Math.min(Math.max(0, raw), view.durationMs);
    };

    return (
        <div
            ref={scrollRef}
            className="min-w-0 flex-1 overflow-x-auto pl-2 scrollbar-ed"
        >
            {/*
                **最小一屏宽。** 片子短的时候（5 秒的成片按 50px/秒 只有 250px）
                轨道会缩成角落里一小条，看着像是"时间线坏了"。
                `minWidth: 100%` 让它至少铺满可视区，长片仍按真实宽度横向滚。
            */}
            <div
                className="relative flex flex-col gap-8"
                style={{ width: view.totalWidthPx, minWidth: '100%' }}
                {...(onSeek
                    ? {
                          onClick: (event: MouseEvent<HTMLDivElement>) =>
                              onSeek(timeAt(event))
                      }
                    : {})}
                {...(onHover
                    ? {
                          onMouseMove: (event: MouseEvent<HTMLDivElement>) =>
                              onHover(timeAt(event)),
                          // 移开就还原：悬停预览是"看一眼"，不是改播放位置
                          onMouseLeave: () => onHover(null)
                      }
                    : {})}
            >
                <TimeRuler view={view} />
                {view.tracks.map((track) => (
                    <Lane key={track.id}>
                        {track.clips.map((clip) => (
                            <ClipOf key={clip.id} clip={clip} />
                        ))}
                    </Lane>
                ))}
                <Playhead leftPx={leftPx} />
                {/* 悬停头：另一种颜色，和真正的播放头分得开 */}
                {hoverMs === null || hoverMs === undefined ? null : (
                    <Playhead leftPx={hoverMs * pxPerMs} hover />
                )}
            </div>
        </div>
    );
}
