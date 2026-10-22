import type { AssetId, SceneId, VideoProject } from './schema';

/**
 * 按新的配音时长重排整条时间线。
 *
 * ## 什么时候用得上
 *
 * 换个音色重新合成一遍口播——**每一镜的长度都会变**。时间轴是由配音驱动的
 * （分镜长度 == 该镜配音时长之和），所以配音一换，分镜起点、画面区间、
 * 字幕位置、画布总时长全要跟着重算。
 *
 * 这和分割不是一回事：分割**不改变任何时长**，只是把一镜记成两镜。
 *
 * ## 为什么是纯函数
 *
 * 重排牵动四条轨道和九条不变量。放在"合成完顺手改一下"的流程里，
 * 验证它就只剩下**在界面上播一遍看看对不对**——而时长错一毫秒的工程
 * 在界面上看起来完全正常，只有导出那天才会炸。
 */

export class RelayoutError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'RelayoutError';
    }
}

/** 一镜重新合成之后的产物 */
export interface SceneVoiceUpdate {
    sceneId: string;
    /** 实测时长。**不是估算**——时间轴的正确性不能依赖估计值 */
    durationMs: number;
    /** 新的音频资产 id。不换文件时可以不给 */
    assetId?: string | undefined;
    /** 合成来源，便于追溯 */
    provider?: { name: string; model: string; voiceId: string } | undefined;
}

/**
 * 把一镜内的字幕整体重排到新的长度。
 *
 * ## 只对**边界**取整，时长由相邻边界相减得到
 *
 * 一镜内的字幕是首尾相接的（`layoutSubtitles` 按边界切块，后一条的起点就是
 * 前一条的终点）。如果逐条独立缩放——起点和时长各取整一次——就会出事：
 *
 * ```
 * 前一条新终点 = round(起点 × 比例) + round(时长 × 比例)
 * 后一条新起点 = round(终点 × 比例)
 * ```
 *
 * 而 `round(a) + round(b)` 可以比 `round(a + b)` 大 1。差这 1ms，后一条就比
 * 前一条的终点还早，`track_overlap` 直接判整份工程非法，重排被放弃。
 *
 * 改成只映射边界之后，**相邻两条共用的那个边界只算一次**，相接的关系在映射后
 * 必然保持。原本有空档的（示例工程那种）也照样保留——`round` 单调不减。
 *
 * 两处夹取：末条不得越出镜尾（硬不变量），每条至少留 1ms（零长过不了 schema）。
 * 宁可某一条短一毫秒，也不要工程非法。
 */
function relayoutSubtitlesInScene(
    clips: readonly { id: string; startMs: number; durationMs: number }[],
    oldSceneStartMs: number,
    at: { startMs: number; durationMs: number; ratio: number },
    sceneId: string
): Map<string, { startMs: number; durationMs: number }> {
    const placed = new Map<string, { startMs: number; durationMs: number }>();
    const ordered = [...clips].sort((a, b) => a.startMs - b.startMs);
    const map = (localMs: number): number => Math.round(localMs * at.ratio);

    let cursor = 0;
    for (const clip of ordered) {
        if (cursor >= at.durationMs) {
            // 实际上到不了：一条字幕有 `minDurationMs` 兜底，镜长也不会短到这个地步。
            // 真撞上了也要说清楚，而不是悄悄吐一份重叠的工程出去
            throw new RelayoutError(
                `分镜 ${sceneId} 的新长度 ${at.durationMs}ms 装不下 ${ordered.length} 条字幕`
            );
        }

        const localStart = clip.startMs - oldSceneStartMs;
        const start = Math.min(
            Math.max(map(localStart), cursor),
            at.durationMs - 1
        );
        const end = Math.min(
            Math.max(map(localStart + clip.durationMs), start + 1),
            at.durationMs
        );

        placed.set(clip.id, {
            startMs: at.startMs + start,
            durationMs: end - start
        });
        cursor = end;
    }
    return placed;
}

export function relayoutFromVoiceDurations(
    project: VideoProject,
    updates: readonly SceneVoiceUpdate[]
): VideoProject {
    const byScene = new Map(updates.map((item) => [item.sceneId, item]));

    for (const scene of project.scenes) {
        const update = byScene.get(scene.id);
        if (!update) {
            throw new RelayoutError(`分镜 ${scene.id} 没有新的配音时长`);
        }
        if (!Number.isInteger(update.durationMs) || update.durationMs <= 0) {
            throw new RelayoutError(
                `分镜 ${scene.id} 的配音时长不可用：${update.durationMs}`
            );
        }
        /**
         * 一镜多段配音时**不重排**。
         *
         * 多段意味着这一镜的文案被切过（停顿、换气、或者分割留下的），
         * 而重新合成给回来的是**一整段**——硬塞进去就要决定那几段各占多久，
         * 任何分法都是编的。说清楚比算错好。
         */
        if (scene.refs.voice.length !== 1) {
            throw new RelayoutError(
                `分镜 ${scene.id} 有 ${scene.refs.voice.length} 段配音，` +
                    `重新合成只支持单段的`
            );
        }
    }

    // ── 先把每一镜的新起点算出来，后面四条轨道都认它 ─────────────────────
    let cursor = 0;
    const layout = new Map<
        string,
        { startMs: number; durationMs: number; ratio: number }
    >();
    for (const scene of project.scenes) {
        const next = byScene.get(scene.id)!.durationMs;
        layout.set(scene.id, {
            startMs: cursor,
            durationMs: next,
            ratio: next / scene.durationMs
        });
        cursor += next;
    }
    const totalMs = cursor;

    const scenes = project.scenes.map((scene) => {
        const at = layout.get(scene.id)!;
        return { ...scene, startMs: at.startMs, durationMs: at.durationMs };
    });

    const tracks = project.tracks.map((track) => {
        switch (track.kind) {
            case 'voice':
                return {
                    ...track,
                    clips: track.clips.map((clip) => {
                        const at = layout.get(clip.sceneId);
                        if (!at) return clip;
                        const update = byScene.get(clip.sceneId)!;
                        return {
                            ...clip,
                            startMs: at.startMs,
                            durationMs: at.durationMs,
                            // 新合成的是整段，源内区间从头到尾
                            inMs: 0,
                            outMs: at.durationMs,
                            ...(update.assetId
                                ? { assetId: update.assetId as AssetId }
                                : {}),
                            ...(update.provider
                                ? { provider: update.provider }
                                : {})
                        };
                    })
                };

            case 'video':
                return {
                    ...track,
                    clips: track.clips.map((clip) => {
                        const at = layout.get(clip.sceneId);
                        if (!at) return clip;

                        /**
                         * 镜头变长时**尽量多铺一点素材**，而不是继续定格。
                         *
                         * 素材本来就比原来那一镜长的话（`outMs` 之后还有），
                         * 延长 `outMs` 是免费的画面；只有素材真的不够时才定格。
                         * 不往回看素材长度的话，换个慢音色就会让每一镜都定格，
                         * 而画面明明是有的。
                         */
                        const asset = project.assets[clip.assetId];
                        const available = Math.max(
                            0,
                            (asset?.durationMs ?? clip.outMs) - clip.inMs
                        );
                        const span = Math.min(available, at.durationMs);

                        return {
                            ...clip,
                            startMs: at.startMs,
                            durationMs: at.durationMs,
                            outMs: clip.inMs + span,
                            holdLastFrame: span < at.durationMs
                        };
                    })
                };

            case 'subtitle': {
                // 一镜一镜地排：边界映射要在同一镜内顺着时间走，逐条独立算会错开 1ms
                const placed = new Map<
                    string,
                    { startMs: number; durationMs: number }
                >();
                for (const scene of project.scenes) {
                    const at = layout.get(scene.id);
                    if (!at) continue;
                    const inScene = track.clips.filter(
                        (clip) => clip.sceneId === scene.id
                    );
                    if (inScene.length === 0) continue;

                    for (const [id, box] of relayoutSubtitlesInScene(
                        inScene,
                        scene.startMs,
                        at,
                        scene.id
                    )) {
                        placed.set(id, box);
                    }
                }

                return {
                    ...track,
                    clips: track.clips.map((clip) => {
                        const box = placed.get(clip.id);
                        return box ? { ...clip, ...box } : clip;
                    })
                };
            }

            case 'music':
                /**
                 * 配乐必须盖满 `[0, 总时长]`（不变量 6）。
                 * 片子变长了却不改配乐，后面那一段就是**静音**，
                 * 而时间线上那条音乐轨看着仍然是满的。
                 */
                return {
                    ...track,
                    clips: track.clips.map((clip) => ({
                        ...clip,
                        startMs: 0,
                        durationMs: totalMs
                    }))
                };

            default:
                return track;
        }
    });

    return {
        ...project,
        canvas: { ...project.canvas, durationMs: totalMs },
        scenes,
        tracks
    };
}

/** 重新合成之前先问一句能不能做。不能做时给出**人能看懂的原因** */
export function relayoutBlockedReason(
    project: VideoProject | undefined
): string | null {
    if (!project) return '还没有打开工程';
    if (project.scenes.length === 0) return '这条片子还没有分镜';

    const multi = project.scenes.find((scene) => scene.refs.voice.length !== 1);
    if (multi) {
        return `分镜 ${multi.id} 有多段配音，重新合成只支持单段的`;
    }

    const empty = project.scenes.find((scene) => scene.script.trim() === '');
    if (empty) return `分镜 ${empty.id} 没有文案，合成不出声音`;

    return null;
}

/** 重新合成会把哪些分镜的 id 送去合成。顺序即时间线顺序 */
export function scenesToSynthesize(
    project: VideoProject
): { sceneId: SceneId; script: string }[] {
    return project.scenes.map((scene) => ({
        sceneId: scene.id,
        script: scene.script
    }));
}
