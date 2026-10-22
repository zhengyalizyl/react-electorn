import type {
    MusicClip,
    SubtitleClip,
    VideoClip,
    VideoProject,
    VoiceClip
} from './schema';

/**
 * 预览播放要用的纯计算。
 *
 * ## 为什么单独一层
 *
 * 「此刻该放哪个片段、从素材的第几秒开始放」是**纯函数能回答的问题**，
 * 而 `<video>` 的状态机（load/seek/play 的时序）是另一回事。
 * 混在组件里的话，"跳到 7.5 秒画面不对"这种问题就只能靠肉眼在界面上试。
 *
 * ## 边界一律取左闭右开
 *
 * 片段首尾相接（`startMs + durationMs === 下一段的 startMs`），
 * 边界那一毫秒必须**只属于后一段**——两段都认的话，接缝处会来回跳。
 */

export interface ActiveClips {
    video: VideoClip | null;
    voice: VoiceClip | null;
    subtitle: SubtitleClip | null;
    music: MusicClip | null;
}

interface TimedClip {
    startMs: number;
    durationMs: number;
}

/** 左闭右开：`[startMs, startMs + durationMs)` */
export function covers(clip: TimedClip, timeMs: number): boolean {
    return timeMs >= clip.startMs && timeMs < clip.startMs + clip.durationMs;
}

function findAt<T extends TimedClip>(
    clips: readonly T[],
    timeMs: number
): T | null {
    return clips.find((clip) => covers(clip, timeMs)) ?? null;
}

/** 此刻四条轨道各该放哪个片段。没有就是 null——**不找最近的那个**，那是编的 */
export function clipsAt(project: VideoProject, timeMs: number): ActiveClips {
    const result: ActiveClips = {
        video: null,
        voice: null,
        subtitle: null,
        music: null
    };

    // 按轨道类型分派。用判别联合而不是泛型查表：
    // 轨道与片段的类型是一一对应的，查表那种写法反而要靠断言把它接回来
    for (const track of project.tracks) {
        switch (track.kind) {
            case 'video':
                result.video = findAt(track.clips, timeMs);
                break;
            case 'voice':
                result.voice = findAt(track.clips, timeMs);
                break;
            case 'subtitle':
                result.subtitle = findAt(track.clips, timeMs);
                break;
            case 'music':
                result.music = findAt(track.clips, timeMs);
                break;
            default:
                break;
        }
    }

    return result;
}

/**
 * 时间轴上的时刻 → 素材文件内的时刻。
 *
 * 视频片段带 `inMs`（源内起点），所以要加上它；**不做变速**，
 * 所以是简单相加而不是按比例缩放。
 */
export function sourceTimeMs(
    clip: { startMs: number; inMs?: number; outMs?: number },
    timeMs: number
): number {
    const raw = timeMs - clip.startMs + (clip.inMs ?? 0);

    /**
     * **素材比分镜短时定格在最后一帧**，而不是让画面消失或跳回开头。
     *
     * 工程里 `holdLastFrame` 已经把这件事声明清楚了（见 schema）。
     * 这里照它执行即可——但**不越界这件事是无条件的**：
     * `currentTime` 被写到素材长度之外时，浏览器要么停在末尾、要么抛
     * `seeking` 抖一下，表现全看实现。所以有 `outMs` 就一律夹住。
     *
     * 定格是明确选择：观众看到的是一个静止画面，不是黑屏或闪烁。
     */
    const upper = clip.outMs;
    if (upper !== undefined) {
        // 停在最后一帧之内：刚好等于 outMs 时多数实现会认为已经播完
        return Math.min(Math.max(0, raw), Math.max(0, upper - 1));
    }
    return Math.max(0, raw);
}

/** `0:07 / 0:12`。与时间轴刻度同一种写法 */
export function formatPlayhead(ms: number): string {
    const total = Math.max(0, Math.round(ms / 1000));
    return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
}

/**
 * 播放头此刻落在第几镜。
 *
 * **左侧文稿、右侧配置区、预览必须认同一个"当前分镜"。** 之前编辑器把它存成
 * 一份独立的 state，播放推进时没人更新——播放头走到第 3 镜，左边还高亮着第 1 镜，
 * 右边配置区改的也是第 1 镜的东西，而界面上完全看不出这种错位。
 *
 * 播完停在末尾那一刻（`timeMs === durationMs`）按左闭右开谁都不覆盖，
 * 这时算**最后一镜**：那才是屏幕上正停着的画面。
 *
 * 分镜为空返回 0——没有镜头可选时调用方拿到的仍是个合法下标。
 */
export function sceneIndexAt(project: VideoProject, timeMs: number): number {
    const index = project.scenes.findIndex((scene) => covers(scene, timeMs));
    if (index !== -1) return index;
    if (project.scenes.length === 0) return 0;
    // 播放头在第一镜之前（理论上到不了，除非工程不从 0 开始）仍取第一镜
    return timeMs <= 0 ? 0 : project.scenes.length - 1;
}
