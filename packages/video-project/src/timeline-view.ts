import type { Clip, ClipId, Track, TrackId, VideoProject } from './schema';

/**
 * VideoProject → 时间线视图模型的**纯投影**。
 *
 * 这一层的存在理由：渲染层不该自己做「毫秒 → 像素」的换算。
 * 换算散在组件里，缩放就只能是装饰——每个组件都得记得乘一遍 pxPerMs，
 * 漏一个地方就会出现轨道之间对不齐。
 *
 * 输入假定是已通过 `validateProject` 的工程。这里不再校验，
 * 非法工程投影出来的结果没有意义，但也不会抛错。
 */

/** 缩放：每毫秒多少像素。0.05 即 50px/秒 */
export type PxPerMs = number;

export interface TimelineClipView {
    id: ClipId;
    kind: Clip['kind'];
    /** 所属分镜的序号（0 基）。音乐 clip 不属于任何分镜，为 null */
    sceneIndex: number | null;
    /** 默认显示名。渲染层可以不用它，但多数情况下直接用就对了 */
    label: string;
    startMs: number;
    durationMs: number;
    leftPx: number;
    widthPx: number;
}

export interface TimelineTrackView {
    id: TrackId;
    kind: Track['kind'];
    clips: TimelineClipView[];
}

export interface TimelineRulerMark {
    atMs: number;
    leftPx: number;
    /** `mm:ss`，超过一小时才带小时位 */
    label: string;
}

export interface TimelineRulerView {
    /** 实际采用的刻度间隔。由 pxPerMs 反推，保证刻度不会挤成一团 */
    intervalMs: number;
    marks: TimelineRulerMark[];
}

export interface TimelineView {
    pxPerMs: PxPerMs;
    durationMs: number;
    totalWidthPx: number;
    tracks: TimelineTrackView[];
    ruler: TimelineRulerView;
}

/**
 * 刻度阶梯。只从这些"整"间隔里挑，避免出现「每 3.7 秒一格」这种读不出来的刻度。
 */
const TICK_LADDER_MS = [
    500, 1000, 2000, 5000, 10_000, 15_000, 30_000, 60_000, 120_000, 300_000,
    600_000, 1_800_000
] as const;

/** 两个刻度之间至少要有这么宽，否则标签会叠在一起 */
const MIN_TICK_SPACING_PX = 110;

/** 选一个让刻度间距不小于 MIN_TICK_SPACING_PX 的最小间隔 */
export function pickTickInterval(pxPerMs: PxPerMs): number {
    if (!(pxPerMs > 0)) return TICK_LADDER_MS[TICK_LADDER_MS.length - 1]!;
    for (const tick of TICK_LADDER_MS) {
        if (tick * pxPerMs >= MIN_TICK_SPACING_PX) return tick;
    }
    // 缩到极小时阶梯也兜不住，用最大档——总比让刻度糊成一片好
    return TICK_LADDER_MS[TICK_LADDER_MS.length - 1]!;
}

/** `mm:ss`；满一小时才补小时位。负数按 0 处理 */
export function formatTimecode(ms: number): string {
    const total = Math.max(0, Math.floor(ms / 1000));
    const seconds = total % 60;
    const minutes = Math.floor(total / 60) % 60;
    const hours = Math.floor(total / 3600);
    const mm = String(minutes).padStart(2, '0');
    const ss = String(seconds).padStart(2, '0');
    return hours > 0 ? `${hours}:${mm}:${ss}` : `${mm}:${ss}`;
}

/** `00:04-00:08` 这种区间文本，供分镜卡片使用 */
export function formatRange(startMs: number, durationMs: number): string {
    return `${formatTimecode(startMs)}-${formatTimecode(startMs + durationMs)}`;
}

function labelOf(
    clip: Clip,
    sceneIndex: number | null,
    sceneNo: string
): string {
    switch (clip.kind) {
        case 'video':
            return `分镜${sceneNo}`;
        case 'voice':
            return sceneIndex === null ? '配音' : `配音 ${sceneNo}`;
        case 'subtitle':
            return clip.text;
        case 'music':
            // 曲名没有专门字段，用资源 id 兜底；渲染层拿到 assets 可以显示更好的名字
            return clip.assetId;
        default:
            return '';
    }
}

/**
 * 把 clip 投影到像素。
 *
 * **按两端取整，而不是对宽度取整**：`round(start) → round(end)` 保证相邻 clip
 * 的右边界与下一个的左边界严丝合缝。先算宽度再累加会攒出舍入误差，
 * 几十个片段之后轨道之间就会错开一两像素。
 */
function projectClip(
    clip: Clip,
    pxPerMs: PxPerMs,
    sceneIndexById: ReadonlyMap<string, number>
): TimelineClipView {
    const sceneIndex =
        clip.kind === 'music'
            ? null
            : (sceneIndexById.get(clip.sceneId) ?? null);
    const sceneNo =
        sceneIndex === null ? '' : String(sceneIndex + 1).padStart(2, '0');

    const leftPx = Math.round(clip.startMs * pxPerMs);
    const rightPx = Math.round((clip.startMs + clip.durationMs) * pxPerMs);

    return {
        id: clip.id,
        kind: clip.kind,
        sceneIndex,
        label: labelOf(clip, sceneIndex, sceneNo),
        startMs: clip.startMs,
        durationMs: clip.durationMs,
        leftPx,
        widthPx: Math.max(0, rightPx - leftPx)
    };
}

function buildRuler(durationMs: number, pxPerMs: PxPerMs): TimelineRulerView {
    const intervalMs = pickTickInterval(pxPerMs);
    const marks: TimelineRulerMark[] = [];
    // 闭区间：末尾那一刻也要有刻度，否则时间线右端看起来像没走完
    for (let atMs = 0; atMs <= durationMs; atMs += intervalMs) {
        marks.push({
            atMs,
            leftPx: Math.round(atMs * pxPerMs),
            label: formatTimecode(atMs)
        });
    }
    return { intervalMs, marks };
}

/**
 * 主投影。给定工程与缩放，得到可以直接渲染的视图模型。
 *
 * 轨道顺序**原样保留**工程里的顺序——顺序是工程的一部分，不由这里重排。
 */
export function projectToTimelineView(
    project: VideoProject,
    pxPerMs: PxPerMs
): TimelineView {
    const scale = pxPerMs > 0 ? pxPerMs : 0;
    const sceneIndexById = new Map<string, number>(
        project.scenes.map((scene) => [scene.id as string, scene.index])
    );

    return {
        pxPerMs: scale,
        durationMs: project.canvas.durationMs,
        totalWidthPx: Math.round(project.canvas.durationMs * scale),
        tracks: project.tracks.map((track) => ({
            id: track.id,
            kind: track.kind,
            clips: track.clips.map((clip) =>
                projectClip(clip, scale, sceneIndexById)
            )
        })),
        ruler: buildRuler(project.canvas.durationMs, scale)
    };
}
