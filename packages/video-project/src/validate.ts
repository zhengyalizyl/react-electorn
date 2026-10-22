import type { AssetId, ClipId, SceneId, VideoProject } from './schema';

/**
 * 七条不变量的语义校验（docs/video-agent/plan.md §7.2）。
 *
 * 与 Zod 的分工：Zod 管**结构**（字段有没有、类型对不对、轨道有没有混进错类型的
 * clip）；这里管**跨字段的语义一致性**，那些是 Zod 表达不了的。
 *
 * 输出刻意做成结构化的：repair 节点要靠 code + expected/actual 决定下一轮
 * 检索加什么约束，给一串人类可读的字符串是没法用的。
 */

export type ValidationCode =
    /** 1. 分镜时长与其配音时长不一致 */
    | 'scene_duration_mismatch'
    /** 2. 视频 clip 的源内区间长度与时间线时长不符（本方案不做变速） */
    | 'video_span_mismatch'
    | 'voice_span_mismatch'
    /** 2. 裁切区间超出源素材长度 */
    | 'video_out_of_source'
    /** 3. 同轨 clip 重叠 */
    | 'track_overlap'
    /** 3. 连续轨（视频/配音）出现空洞 */
    | 'track_gap'
    /** 4. 分镜时长之和与画布总时长不符 */
    | 'total_duration_mismatch'
    /** 5. 字幕越出所属分镜区间 */
    | 'subtitle_out_of_scene'
    /** 6. 音乐未铺满整片 */
    | 'music_not_covering'
    /** 7. 引用的 id 不存在 */
    | 'dangling_ref'
    /**
     * 8. 分镜的文稿与各段配音文本对不上。
     *
     * **文稿字幕里显示的必须就是送进 TTS 的那串字**——对不上的时候，
     * 用户听到的和读到的是两回事，而界面上完全看不出来。
     */
    | 'script_voice_mismatch'
    /** 9. 一个分镜对应了不止一个视频片段。一镜之内换画面就不是同一镜了 */
    | 'scene_video_not_unique';

export interface ValidationIssue {
    code: ValidationCode;
    message: string;
    sceneId?: SceneId;
    clipId?: ClipId;
    assetId?: AssetId;
    /** 期望值与实际值，单位均为毫秒。repair 用它算下一轮的硬过滤条件 */
    expectedMs?: number;
    actualMs?: number;
}

/** 连续轨：clip 必须从 0 起首尾相接，不允许空洞 */
const CONTINUOUS_KINDS = new Set(['video', 'voice']);

export function validateProject(project: VideoProject): ValidationIssue[] {
    const issues: ValidationIssue[] = [];

    const clipsById = new Map<
        ClipId,
        (typeof project.tracks)[number]['clips'][number]
    >();

    for (const track of project.tracks) {
        for (const clip of track.clips) {
            clipsById.set(clip.id, clip);
        }
    }

    const sceneById = new Map(project.scenes.map((scene) => [scene.id, scene]));

    // ── 7. 引用完整性。先查它：后面几条都建立在引用有效的前提上
    for (const track of project.tracks) {
        for (const clip of track.clips) {
            if ('assetId' in clip && !project.assets[clip.assetId]) {
                issues.push({
                    code: 'dangling_ref',
                    message: `clip ${clip.id} 引用了不存在的素材 ${clip.assetId}`,
                    clipId: clip.id,
                    assetId: clip.assetId
                });
            }

            if ('sceneId' in clip && !sceneById.has(clip.sceneId)) {
                issues.push({
                    code: 'dangling_ref',
                    message: `clip ${clip.id} 引用了不存在的分镜 ${clip.sceneId}`,
                    clipId: clip.id,
                    sceneId: clip.sceneId
                });
            }

            if (clip.kind === 'subtitle' && !project.styles[clip.styleRef]) {
                issues.push({
                    code: 'dangling_ref',
                    message: `字幕 ${clip.id} 引用了不存在的样式 ${clip.styleRef}`,
                    clipId: clip.id
                });
            }
        }
    }

    for (const scene of project.scenes) {
        for (const refId of [
            scene.refs.video,
            ...scene.refs.voice,
            ...scene.refs.subtitle
        ]) {
            if (!clipsById.has(refId)) {
                issues.push({
                    code: 'dangling_ref',
                    message: `分镜 ${scene.id} 引用了不存在的 clip ${refId}`,
                    sceneId: scene.id,
                    clipId: refId
                });
            }
        }
    }

    // ── 1. 分镜时长 == 其**所有**配音时长之和
    //
    // 一个分镜可以有多段配音（停顿、换气、分句合成）。逐条比对的话，
    // 分成两段就必然报错——而那是合法的。
    for (const scene of project.scenes) {
        const voices = scene.refs.voice
            .map((id) => clipsById.get(id))
            .filter((clip) => clip !== undefined);
        if (voices.length !== scene.refs.voice.length) continue; // 悬空引用已经报过

        const totalMs = voices.reduce((sum, clip) => sum + clip.durationMs, 0);
        if (totalMs !== scene.durationMs) {
            issues.push({
                code: 'scene_duration_mismatch',
                message:
                    `分镜 ${scene.id} 时长 ${scene.durationMs}ms 与配音合计 ` +
                    `${totalMs}ms（${voices.length} 段）不一致`,
                sceneId: scene.id,
                clipId: voices[0]!.id,
                expectedMs: totalMs,
                actualMs: scene.durationMs
            });
        }
    }

    /**
     * ── 1b. **文稿字幕里显示的 == 送进 TTS 的**
     *
     * 分镜的 `script` 是界面上给人看的那段话；各段配音的 `text` 是真的拿去
     * 合成的那串字。两者对不上时，用户听到的和读到的就是两回事——
     * 而这种错位在界面上**完全看不出来**，只能靠耳朵发现。
     *
     * 比较前去掉首尾空白：分段时在段间补一个空格是排版行为，不是内容差异。
     */
    for (const scene of project.scenes) {
        const voices = scene.refs.voice
            .map((id) => clipsById.get(id))
            .filter((clip) => clip !== undefined);
        if (voices.length !== scene.refs.voice.length) continue;

        const spoken = voices
            .map((clip) => (clip.kind === 'voice' ? clip.text : ''))
            .join('')
            .trim();
        if (spoken !== scene.script.trim()) {
            issues.push({
                code: 'script_voice_mismatch',
                message:
                    `分镜 ${scene.id} 的文稿与配音文本对不上：` +
                    `文稿「${scene.script.trim()}」，配音「${spoken}」`,
                sceneId: scene.id,
                clipId: voices[0]!.id
            });
        }
    }

    /**
     * ── 1b2. 配音 clip 的源内区间与时长
     *
     * 和视频同一条规矩：**不做变速**，所以 `outMs - inMs` 必须等于时间线时长。
     * 配音没有「定格」这种降级——声音放完就是放完了，不能停在最后一个采样上。
     *
     * 这条是分割之后最容易出错的地方：切完忘了改 `outMs`，
     * 两半就会各自把整段音频从头播一遍，而**时间线上看起来完全正常**。
     */
    for (const track of project.tracks) {
        if (track.kind !== 'voice') continue;

        for (const clip of track.clips) {
            const span = clip.outMs - clip.inMs;
            if (span === clip.durationMs) continue;

            issues.push({
                code: 'voice_span_mismatch',
                message:
                    `配音 ${clip.id} 源内区间 ${span}ms 与时间线时长 ` +
                    `${clip.durationMs}ms 不符（本方案不做变速）`,
                clipId: clip.id,
                sceneId: clip.sceneId,
                expectedMs: clip.durationMs,
                actualMs: span
            });
        }
    }

    /**
     * ── 1c. 一个分镜**恰好**一个视频片段
     *
     * 一镜之内换画面就不是同一镜了，那是两镜。多出来的片段会在时间线上
     * 和正主重叠，播放时谁在上面全看轨道顺序——那不是"能接受的降级"，是乱。
     */
    for (const scene of project.scenes) {
        const owned = project.tracks
            .filter((track) => track.kind === 'video')
            .flatMap((track) => track.clips)
            .filter((clip) => clip.sceneId === scene.id);

        if (owned.length > 1) {
            issues.push({
                code: 'scene_video_not_unique',
                message: `分镜 ${scene.id} 有 ${owned.length} 个视频片段，一个分镜只能对应一个`,
                sceneId: scene.id,
                clipId: owned[1]!.id
            });
        }
    }

    // ── 2. 视频 clip 的源内区间与时长、与源素材长度
    for (const track of project.tracks) {
        if (track.kind !== 'video') {
            continue;
        }

        for (const clip of track.clips) {
            const span = clip.outMs - clip.inMs;

            /**
             * 不做变速，所以源内区间长度必须等于时间线时长——
             * **除非这一镜声明了定格**（`holdLastFrame`）。
             *
             * 定格时素材比分镜短是**意料之中**的：画面放到素材末尾，
             * 剩下的时间停在最后一帧。这时只要求"不超过"。
             * 反过来仍然不行：素材比分镜长却声明定格，说明时长算错了。
             */
            const ok = clip.holdLastFrame
                ? span <= clip.durationMs
                : span === clip.durationMs;

            if (!ok) {
                issues.push({
                    code: 'video_span_mismatch',
                    message: clip.holdLastFrame
                        ? `视频 ${clip.id} 声明了定格，但源内区间 ${span}ms 比时间线时长 ${clip.durationMs}ms 还长`
                        : `视频 ${clip.id} 源内区间 ${span}ms 与时间线时长 ${clip.durationMs}ms 不符（本方案不做变速）`,
                    clipId: clip.id,
                    sceneId: clip.sceneId,
                    expectedMs: clip.durationMs,
                    actualMs: span
                });
            }

            const asset = project.assets[clip.assetId];

            if (asset && clip.outMs > asset.durationMs) {
                issues.push({
                    code: 'video_out_of_source',
                    message: `视频 ${clip.id} 裁到 ${clip.outMs}ms，超出素材长度 ${asset.durationMs}ms`,
                    clipId: clip.id,
                    sceneId: clip.sceneId,
                    assetId: clip.assetId,
                    expectedMs: asset.durationMs,
                    actualMs: clip.outMs
                });
            }
        }
    }

    // ── 3. 同轨无重叠；连续轨无空洞
    for (const track of project.tracks) {
        const ordered = [...track.clips].sort((a, b) => a.startMs - b.startMs);
        const continuous = CONTINUOUS_KINDS.has(track.kind);
        let cursor = 0;

        for (const clip of ordered) {
            if (clip.startMs < cursor) {
                issues.push({
                    code: 'track_overlap',
                    message: `${track.kind} 轨的 ${clip.id} 起点 ${clip.startMs}ms 早于前一片段结束 ${cursor}ms`,
                    clipId: clip.id,
                    expectedMs: cursor,
                    actualMs: clip.startMs
                });
            } else if (continuous && clip.startMs > cursor) {
                issues.push({
                    code: 'track_gap',
                    message: `${track.kind} 轨在 ${cursor}–${clip.startMs}ms 之间有空洞`,
                    clipId: clip.id,
                    expectedMs: cursor,
                    actualMs: clip.startMs
                });
            }

            cursor = clip.startMs + clip.durationMs;
        }
    }

    // ── 4. 分镜时长之和 == 画布总时长
    const scenesTotal = project.scenes.reduce(
        (sum, scene) => sum + scene.durationMs,
        0
    );

    if (scenesTotal !== project.canvas.durationMs) {
        issues.push({
            code: 'total_duration_mismatch',
            message: `分镜总时长 ${scenesTotal}ms 与画布时长 ${project.canvas.durationMs}ms 不符`,
            expectedMs: project.canvas.durationMs,
            actualMs: scenesTotal
        });
    }

    // ── 5. 字幕落在所属分镜区间内
    for (const track of project.tracks) {
        if (track.kind !== 'subtitle') {
            continue;
        }

        for (const clip of track.clips) {
            const scene = sceneById.get(clip.sceneId);

            if (!scene) {
                continue; // 已在第 7 条报过
            }

            const sceneEnd = scene.startMs + scene.durationMs;
            const clipEnd = clip.startMs + clip.durationMs;

            if (clip.startMs < scene.startMs || clipEnd > sceneEnd) {
                issues.push({
                    code: 'subtitle_out_of_scene',
                    message: `字幕 ${clip.id} 区间 ${clip.startMs}–${clipEnd}ms 越出分镜 ${scene.id} 的 ${scene.startMs}–${sceneEnd}ms`,
                    clipId: clip.id,
                    sceneId: scene.id,
                    expectedMs: sceneEnd,
                    actualMs: clipEnd
                });
            }
        }
    }

    // ── 6. 音乐覆盖 [0, durationMs]
    for (const track of project.tracks) {
        if (track.kind !== 'music') {
            continue;
        }

        const ordered = [...track.clips].sort((a, b) => a.startMs - b.startMs);
        const first = ordered[0];

        if (!first) {
            issues.push({
                code: 'music_not_covering',
                message: '音乐轨为空，未覆盖整片',
                expectedMs: project.canvas.durationMs,
                actualMs: 0
            });
            continue;
        }

        if (first.startMs !== 0) {
            issues.push({
                code: 'music_not_covering',
                message: `音乐轨从 ${first.startMs}ms 才开始，未覆盖片头`,
                clipId: first.id,
                expectedMs: 0,
                actualMs: first.startMs
            });
        }

        const last = ordered[ordered.length - 1];

        if (last) {
            const end = last.startMs + last.durationMs;

            if (end < project.canvas.durationMs) {
                issues.push({
                    code: 'music_not_covering',
                    message: `音乐轨在 ${end}ms 结束，未覆盖到 ${project.canvas.durationMs}ms`,
                    clipId: last.id,
                    expectedMs: project.canvas.durationMs,
                    actualMs: end
                });
            }
        }
    }

    return issues;
}
