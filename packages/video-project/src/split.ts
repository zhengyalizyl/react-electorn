import type {
    ClipId,
    SceneId,
    VideoClip,
    VideoProject,
    VoiceClip
} from './schema';

/**
 * 把一镜从中间切成两镜。
 *
 * ## 为什么是纯函数
 *
 * 切割牵动四条轨道、九条不变量，任何一处算错都会让工程变成非法的。
 * 这种东西**必须能单独测**——放在按钮的事件处理里，验证它就只剩"在界面上试试看"。
 *
 * 输入输出都是完整工程：调用方拿到新的那份自己决定是存盘还是压进撤销栈。
 *
 * ## 切的是什么
 *
 * - **分镜**：一分为二，起点时长重算，后面所有镜的 `index` 顺延
 * - **配音**：按源内区间切（`inMs`/`outMs`），**不动音频文件**。
 *   这正是 schema v2 加这两个字段的原因
 * - **画面**：同样按 `inMs`/`outMs` 切。定格那一镜要特殊处理（见下）
 * - **字幕**：按落点归到前后两镜；**跨过切点的那条跟着它的起点走并被夹短**，
 *   因为字幕不能越出所属分镜（不变量 5）
 *
 * ## 为什么文案按字数比例切
 *
 * 不变量 8 要求「分镜文稿 == 各段配音文本拼起来」。切点落在音频的某一毫秒上，
 * 而我们**不知道那一刻正念到第几个字**（词级时间戳是可选的，多数时候没有）。
 * 按时长比例折算字数是唯一能保证"拼起来还是原文"的做法——
 * 它不保证切在词的边界上，但**保证工程仍然自洽**。
 * 真要切得准，得等 TTS 返回词级时间戳，那是另一件事。
 */

export class SplitError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'SplitError';
    }
}

/**
 * 切点离镜头两端至少要留这么多。
 *
 * 太靠边会切出一个几十毫秒的碎镜：画面一闪而过，配音一个字都念不完，
 * 而且它仍然要占一条轨道上的位置。与其产出这种东西，不如明确拒绝。
 */
export const MIN_PIECE_MS = 200;

/** 这一刻能不能切。不能切时给出**人能看懂的原因**，而不是一个布尔 */
export function splitBlockedReason(
    project: VideoProject | undefined,
    atMs: number
): string | null {
    if (!project) return '还没有打开工程';

    const scene = project.scenes.find(
        (item) => atMs > item.startMs && atMs < item.startMs + item.durationMs
    );
    if (!scene) return '播放头不在任何一镜里面';

    const head = atMs - scene.startMs;
    const tail = scene.startMs + scene.durationMs - atMs;
    if (head < MIN_PIECE_MS || tail < MIN_PIECE_MS) {
        return `太靠近镜头边缘了，两边各要留 ${MIN_PIECE_MS}ms`;
    }

    // 多段配音的镜头切起来要先决定切在哪一段上，这一版先不做——
    // 说清楚比切出一个错的结果好
    const voices = scene.refs.voice.length;
    if (voices !== 1) return `这一镜有 ${voices} 段配音，暂时只能切单段的`;

    return null;
}

/** 按字数比例把一段文案切成两半。保证拼起来还是原文 */
export function splitScript(script: string, ratio: number): [string, string] {
    const chars = [...script];
    if (chars.length === 0) return ['', ''];

    // 两边都至少留一个字：空的 `text` 过不了 schema（`min(1)`）
    const cut = Math.min(
        chars.length - 1,
        Math.max(1, Math.round(chars.length * ratio))
    );
    return [chars.slice(0, cut).join(''), chars.slice(cut).join('')];
}

/**
 * 工程里已经用掉的全部 id。
 *
 * 轨道是判别联合，`tracks.flatMap(t => t.clips)` 会把四种 clip 压成一个
 * 没法用的交集类型。逐类收窄虽然啰嗦，但不用 `as` 把类型系统蒙过去。
 */
function allIds(project: VideoProject): Set<string> {
    const ids = new Set<string>(project.scenes.map((scene) => scene.id));
    for (const track of project.tracks) {
        switch (track.kind) {
            case 'video':
            case 'voice':
            case 'subtitle':
            case 'music':
                for (const clip of track.clips) ids.add(clip.id);
                break;
            default:
                break;
        }
    }
    return ids;
}

function findVoiceClip(
    project: VideoProject,
    id: string
): VoiceClip | undefined {
    for (const track of project.tracks) {
        if (track.kind !== 'voice') continue;
        const found = track.clips.find((clip) => clip.id === id);
        if (found) return found;
    }
    return undefined;
}

function findVideoClip(
    project: VideoProject,
    id: string
): VideoClip | undefined {
    for (const track of project.tracks) {
        if (track.kind !== 'video') continue;
        const found = track.clips.find((clip) => clip.id === id);
        if (found) return found;
    }
    return undefined;
}

/** `scene_03` → `scene_03b`。不复用序号：序号会随顺延变化，而 id 必须稳定 */
function freshId(used: Set<string>, base: string): string {
    let candidate = `${base}b`;
    let n = 2;
    while (used.has(candidate)) {
        candidate = `${base}b${n}`;
        n += 1;
    }
    used.add(candidate);
    return candidate;
}

export function splitSceneAt(
    project: VideoProject,
    atMs: number
): VideoProject {
    const blocked = splitBlockedReason(project, atMs);
    if (blocked) throw new SplitError(blocked);

    const index = project.scenes.findIndex(
        (item) => atMs > item.startMs && atMs < item.startMs + item.durationMs
    );
    const scene = project.scenes[index]!;

    const headMs = atMs - scene.startMs;
    const tailMs = scene.durationMs - headMs;
    const ratio = headMs / scene.durationMs;

    const usedIds = allIds(project);

    const newSceneId = freshId(usedIds, scene.id) as SceneId;
    const [headScript, tailScript] = splitScript(scene.script, ratio);

    // ── 配音：按源内区间切，音频文件一个字节都不动 ──────────────────────
    const voiceId = scene.refs.voice[0]!;
    const voiceClip = findVoiceClip(project, voiceId);
    if (!voiceClip) {
        throw new SplitError(`分镜 ${scene.id} 的配音片段找不到：${voiceId}`);
    }
    const newVoiceId = freshId(usedIds, voiceClip.id) as ClipId;

    // ── 画面 ──────────────────────────────────────────────────────────────
    const videoClip = findVideoClip(project, scene.refs.video);
    if (!videoClip) {
        throw new SplitError(`分镜 ${scene.id} 的视频片段找不到`);
    }
    const newVideoId = freshId(usedIds, videoClip.id) as ClipId;

    /**
     * 定格那一镜要当心。
     *
     * 定格意味着素材比分镜短（`outMs - inMs < durationMs`），画面播完就停住。
     * 这时候切，**前半段未必还需要定格**——如果素材够铺满前半段，它就是正常片段。
     * 不判这一下的话，前半段会带着一个用不上的 `holdLastFrame`，
     * 而校验要求"声明了定格就不能素材比分镜长"，于是工程直接非法。
     */
    const sourceSpan = videoClip.outMs - videoClip.inMs;
    const headSpan = Math.min(sourceSpan, headMs);
    const tailSpan = Math.max(0, sourceSpan - headSpan);

    const scenes = project.scenes.flatMap((item, i) => {
        if (i < index) return [item];
        if (i > index) return [{ ...item, index: item.index + 1 }];

        return [
            {
                ...item,
                script: headScript,
                durationMs: headMs,
                refs: {
                    ...item.refs,
                    video: videoClip.id,
                    voice: [voiceClip.id]
                }
            },
            {
                ...item,
                id: newSceneId,
                index: item.index + 1,
                startMs: atMs,
                durationMs: tailMs,
                script: tailScript,
                refs: {
                    video: newVideoId,
                    voice: [newVoiceId],
                    subtitle: []
                }
            }
        ];
    });

    const tracks = project.tracks.map((track) => {
        switch (track.kind) {
            case 'voice':
                return {
                    ...track,
                    clips: track.clips.flatMap((clip) =>
                        clip.id !== voiceClip.id
                            ? [clip]
                            : [
                                  {
                                      ...clip,
                                      durationMs: headMs,
                                      outMs: clip.inMs + headMs,
                                      text: headScript
                                  },
                                  {
                                      ...clip,
                                      id: newVoiceId,
                                      sceneId: newSceneId,
                                      startMs: atMs,
                                      durationMs: tailMs,
                                      inMs: clip.inMs + headMs,
                                      outMs: clip.outMs,
                                      text: tailScript
                                  }
                              ]
                    )
                };

            case 'video':
                return {
                    ...track,
                    clips: track.clips.flatMap((clip) =>
                        clip.id !== videoClip.id
                            ? [clip]
                            : [
                                  {
                                      ...clip,
                                      durationMs: headMs,
                                      outMs: clip.inMs + headSpan,
                                      holdLastFrame: headSpan < headMs
                                  },
                                  {
                                      ...clip,
                                      id: newVideoId,
                                      sceneId: newSceneId,
                                      startMs: atMs,
                                      durationMs: tailMs,
                                      inMs: clip.inMs + headSpan,
                                      outMs: clip.inMs + headSpan + tailSpan,
                                      holdLastFrame: tailSpan < tailMs
                                  }
                              ]
                    )
                };

            case 'subtitle':
                return {
                    ...track,
                    clips: track.clips.map((clip) => {
                        if (clip.sceneId !== scene.id) return clip;
                        // 起点在后半段 → 整条归后半段
                        if (clip.startMs >= atMs) {
                            return { ...clip, sceneId: newSceneId };
                        }
                        // 跨过切点 → 跟着起点留在前半段，并夹短到切点
                        const end = clip.startMs + clip.durationMs;
                        return end <= atMs
                            ? clip
                            : { ...clip, durationMs: atMs - clip.startMs };
                    })
                };

            default:
                return track;
        }
    });

    // 字幕换了归属，两镜的 refs 要跟着重建——留着旧的就是悬空引用
    const subtitleIds = new Map<string, ClipId[]>();
    for (const track of tracks) {
        if (track.kind !== 'subtitle') continue;
        for (const clip of track.clips) {
            const list = subtitleIds.get(clip.sceneId) ?? [];
            list.push(clip.id);
            subtitleIds.set(clip.sceneId, list);
        }
    }

    return {
        ...project,
        scenes: scenes.map((item) =>
            item.id === scene.id || item.id === newSceneId
                ? {
                      ...item,
                      refs: {
                          ...item.refs,
                          subtitle: subtitleIds.get(item.id) ?? []
                      }
                  }
                : item
        ),
        tracks
    };
}
