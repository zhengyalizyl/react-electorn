import type { FfmpegBinaries, RunOptions } from './ffmpeg';
import { DEFAULT_BINARIES, runBinary } from './ffmpeg';
import type { MediaKind, ProbeResult } from './types';

/**
 * ffprobe 探测。
 *
 * ## 解析的总原则：单个字段坏掉不该让整个文件作废
 *
 * 素材库里什么样的文件都有——转码器写坏的 `tags`、缺了 `r_frame_rate` 的
 * 流、根本没有 `bit_rate` 的容器。每个字段各自容错，取不到就是 null；
 * **只有在"连一条可用的流都没有"或"这是个视频/音频却没有时长"时才判失败**，
 * 因为这两样缺了，下游连一条 clip 都裁不出来。
 */

/** 文件能被 ffprobe 读取，但里面没有可用的素材流 */
export class UnsupportedMediaError extends Error {
    readonly path: string;

    constructor(path: string, reason: string) {
        super(`${path} 不是可用的素材：${reason}`);
        this.name = 'UnsupportedMediaError';
        this.path = path;
    }
}

/**
 * 探测超时。
 *
 * 比抽帧的默认超时短得多：探测只读元数据，正常文件零点几秒就回来了，
 * 跑满 30 秒必然是文件损坏把解析器卡住了——再等下去只是让整轮索引陪绑。
 */
export const PROBE_TIMEOUT_MS = 30_000;

interface FfprobeSideData {
    rotation?: unknown;
}

interface FfprobeStream {
    codec_type?: unknown;
    codec_name?: unknown;
    width?: unknown;
    height?: unknown;
    duration?: unknown;
    bit_rate?: unknown;
    r_frame_rate?: unknown;
    avg_frame_rate?: unknown;
    disposition?: { attached_pic?: unknown };
    tags?: { rotate?: unknown };
    side_data_list?: unknown;
}

interface FfprobeOutput {
    streams?: unknown;
    format?: { duration?: unknown; bit_rate?: unknown; format_name?: unknown };
}

function asNumber(value: unknown): number | null {
    if (typeof value === 'number') return Number.isFinite(value) ? value : null;
    if (typeof value !== 'string') return null;
    const parsed = Number.parseFloat(value);
    return Number.isFinite(parsed) ? parsed : null;
}

/** 正数才算数。ffprobe 对取不到的数值字段常给 0 或 "N/A" */
function asPositive(value: unknown): number | null {
    const parsed = asNumber(value);
    return parsed !== null && parsed > 0 ? parsed : null;
}

function asText(value: unknown): string | null {
    return typeof value === 'string' && value !== '' ? value : null;
}

/**
 * ffprobe 的帧率是有理数字符串：`"30/1"`、`"30000/1001"`。
 * 取不到时给 `"0/0"`，这时要退到另一个字段，不能除出 NaN 就往下传。
 */
export function parseFrameRate(value: unknown): number | null {
    if (typeof value !== 'string') return null;
    const parts = value.split('/');
    const numerator = asNumber(parts[0]);
    if (numerator === null) return null;
    if (parts.length === 1) return numerator > 0 ? numerator : null;
    const denominator = asNumber(parts[1]);
    if (denominator === null || denominator === 0) return null;
    const fps = numerator / denominator;
    return fps > 0 ? fps : null;
}

/**
 * 旋转角度，归一到 0/90/180/270。
 *
 * 两个来源都要认：新版 ffprobe 放在 `side_data_list[].rotation`（数值，
 * 手机竖拍常见的是 **-90**），老版放在 `tags.rotate`（字符串）。
 * 只认其中一个，就会有一半的竖拍素材被当成横的，预览直接躺倒。
 */
export function parseRotation(stream: FfprobeStream): number {
    const list = Array.isArray(stream.side_data_list)
        ? (stream.side_data_list as FfprobeSideData[])
        : [];
    const fromSideData = list
        .map((item) => asNumber(item?.rotation))
        .find((value) => value !== null);

    const raw = fromSideData ?? asNumber(stream.tags?.rotate);
    if (raw === null) return 0;

    // 负角度要绕回正区间：-90 和 270 是同一个方向
    const normalized = ((Math.round(raw) % 360) + 360) % 360;
    // 非 90 的倍数（极少见，但确实存在）按最近的直角取，省得下游拿到 37° 不知所措
    return [0, 90, 180, 270].reduce((best, candidate) =>
        Math.abs(candidate - normalized) < Math.abs(best - normalized)
            ? candidate
            : best
    );
}

/** 容器名看着像图片管道，就是图片。`png_pipe`、`jpeg_pipe`、`image2`、`webp_pipe` */
function looksLikeImage(formatName: string | null): boolean {
    if (formatName === null) return false;
    return formatName
        .split(',')
        .some((name) => name.endsWith('_pipe') || name === 'image2');
}

/** 从已解析的 ffprobe JSON 里提炼我们要的字段。纯函数，便于单测各种畸形输入 */
export function extractProbeResult(
    raw: unknown,
    path: string,
    hint?: MediaKind
): ProbeResult {
    const output = (raw ?? {}) as FfprobeOutput;
    const streams: FfprobeStream[] = Array.isArray(output.streams)
        ? (output.streams as FfprobeStream[])
        : [];

    // attached_pic 是封面图，它也是一条 video 流，但整片只有一帧——
    // 认成主视频流会算出 0 时长
    const video = streams.find(
        (s) => s.codec_type === 'video' && s.disposition?.attached_pic !== 1
    );
    const audio = streams.find((s) => s.codec_type === 'audio');

    if (!video && !audio) {
        throw new UnsupportedMediaError(path, '既没有视频流也没有音频流');
    }

    const formatName = asText(output.format?.format_name);
    const kind: MediaKind = decideKind({
        hasVideo: video !== undefined,
        hasAudio: audio !== undefined,
        isImageContainer: looksLikeImage(formatName),
        ...(hint ? { hint } : {})
    });

    // ── 宽高：取不到就是 null，不拦路 ──
    let width = asPositive(video?.width);
    let height = asPositive(video?.height);

    // ── 旋转：竖拍素材的宽高要跟着转过来 ──
    const rotationDegrees = video ? parseRotation(video) : 0;
    if (
        (rotationDegrees === 90 || rotationDegrees === 270) &&
        width !== null &&
        height !== null
    ) {
        [width, height] = [height, width];
    }

    // ── 时长：优先容器，退到流级 ──
    // 容器时长算上了所有流，比单条流的 duration 更接近播放器看到的长度；
    // 但 mkv/裸流的容器层常常没有它，这时流级是唯一来源
    const durationSec =
        asPositive(output.format?.duration) ??
        asPositive(video?.duration) ??
        asPositive(audio?.duration);

    if (kind !== 'image' && durationSec === null) {
        // 这一条不容错：没有时长，下游连一条 clip 都裁不出来
        throw new UnsupportedMediaError(path, '拿不到有效时长');
    }

    // ── 码率：优先流级，退到容器级 ──
    const bitRateBps =
        asPositive(video?.bit_rate) ??
        asPositive(audio?.bit_rate) ??
        asPositive(output.format?.bit_rate);

    // ── 帧率：标称值优先，VFR 素材上它可能离谱，所以两个都试 ──
    // 图片的 fps 是 ffprobe 编出来的（常见 25/1），留着只会误导下游
    const fps =
        kind === 'image' || !video
            ? null
            : (parseFrameRate(video.r_frame_rate) ??
              parseFrameRate(video.avg_frame_rate));

    return {
        kind,
        durationMs: durationSec === null ? 0 : Math.round(durationSec * 1000),
        width,
        height,
        fps,
        videoCodec: video ? (asText(video.codec_name) ?? 'unknown') : null,
        hasAudio: audio !== undefined,
        audioCodec: audio ? (asText(audio.codec_name) ?? 'unknown') : null,
        rotationDegrees,
        bitRateBps: bitRateBps === null ? null : Math.round(bitRateBps)
    };
}

/**
 * 真实类型由流构成决定，扫描时的扩展名初判只当兜底。
 *
 * 必须这么判的原因：`.mp4` 和 `.m4a` 的文件头一样，扫描分不出；而一张
 * PNG 在 ffprobe 眼里也是"一条视频流"，光看流类型又会把图片当视频抽帧。
 */
function decideKind(input: {
    hasVideo: boolean;
    hasAudio: boolean;
    isImageContainer: boolean;
    hint?: MediaKind;
}): MediaKind {
    if (input.isImageContainer) return 'image';
    if (!input.hasVideo) return 'audio';
    // 有视频流，但扫描时按扩展名认定是图片（比如 .bmp 走的不是 _pipe 容器）
    if (input.hint === 'image') return 'image';
    return 'video';
}

export interface ProbeOptions extends RunOptions {
    binaries?: FfmpegBinaries;
    /** 扫描阶段按扩展名得到的初判，用于容器层面分不出的情形 */
    kind?: MediaKind;
}

/** spawn ffprobe 探测一个文件 */
export async function probeMediaFile(
    path: string,
    options: ProbeOptions = {}
): Promise<ProbeResult> {
    const binaries = options.binaries ?? DEFAULT_BINARIES;
    const { stdout } = await runBinary(
        binaries.ffprobe,
        [
            '-v',
            'error',
            '-print_format',
            'json',
            '-show_format',
            '-show_streams',
            path
        ],
        {
            // 坏文件能把解析器卡死，探测必须有自己的（短）超时
            timeoutMs: options.timeoutMs ?? PROBE_TIMEOUT_MS,
            ...(options.signal ? { signal: options.signal } : {})
        }
    );

    let parsed: unknown;
    try {
        parsed = JSON.parse(stdout);
    } catch (error) {
        throw new UnsupportedMediaError(
            path,
            `ffprobe 输出不是合法 JSON：${String(error)}`
        );
    }
    return extractProbeResult(parsed, path, options.kind);
}
