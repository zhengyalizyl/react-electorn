import type { VideoProject } from '@magicut-react-demo/video-project';
import {
    CURRENT_SCHEMA_VERSION,
    videoProjectSchema
} from '@magicut-react-demo/video-project';

/**
 * 编辑器用的示例工程：9 个分镜的**合法** VideoProject。
 *
 * ## 为什么要整个换掉原来的 editor-fixtures
 *
 * 原先的数据是逐条抄自设计稿的视觉 mockup：片段只有像素宽度没有时间、
 * 9 个分镜只配了 2 段配音、标尺刻度与片段宽度对应的时间尺度不一致、
 * 分镜 03-06 的时间标签全是 `00:00-00:04`。
 *
 * 那套数据**造不出合法工程**——B1 的不变量要求每个 scene 的时长等于其配音时长、
 * 同轨无空洞、音乐铺满全程。所以这里重建成真实结构，由
 * `projectToTimelineView` 投影出像素。
 *
 * ## 时长怎么定的
 *
 * 按 `DEFAULT_PX_PER_MS = 0.05`（50px/秒）反推，使九个视频片段在默认缩放下的
 * 宽度与设计稿完全一致（215/200/195/205/210/190/225/200/235 px）。
 * 这样视觉尽量贴近原设计，同时数据是真的。
 *
 * 分镜 03-06 的文案是设计稿里的占位乱码，按 pencil-ui-loop 的要求原样保留，
 * 接真实数据前请整体替换。
 */

/** 默认缩放：50px/秒。选它是因为能还原设计稿的片段宽度 */
export const DEFAULT_PX_PER_MS = 0.05;

/**
 * 缩放滑杆的取值范围：以默认值为中心，上下各 8 倍。
 *
 * 刻意取成 `默认 ÷ 8` 与 `默认 × 8`，好让默认值在**对数滑杆上正好落在第 50 格**。
 * 不这么取的话默认值会卡在两格中间，点一下「放大」再点一下「缩小」回不到原位——
 * 滑杆会把它量化到最近的格子上，于是片段宽度从 215 变成 219 再也回不去。
 */
export const MIN_PX_PER_MS = DEFAULT_PX_PER_MS / 8;
export const MAX_PX_PER_MS = DEFAULT_PX_PER_MS * 8;

interface SceneSpec {
    goal: string;
    script: string;
    visualIntent: string;
    /** 由设计稿的片段像素宽 ÷ DEFAULT_PX_PER_MS 得来 */
    durationMs: number;
    /** 字幕分段的字符权重。按行切，行数即段数 */
    subtitleLines: readonly string[];
}

// 文案里的换行既是卡片上的显示换行，也是字幕分段依据——一处数据两处用，不会打架
const sceneSpecs: readonly SceneSpec[] = [
    {
        goal: '开场：把原始素材拖进来',
        script: '开场把原始素材拖入时间线，\n系统开始识别到画面节奏。',
        visualIntent: '桌面录屏，素材被拖入时间线的瞬间',
        durationMs: 4300,
        subtitleLines: [
            '开场把原始素材拖入时间线，',
            '系统开始识别到画面节奏。'
        ]
    },
    {
        goal: '展示 AI 自动挑选高光',
        script: 'AI 自动挑选高光片段，\n同步生成第一版字幕。',
        visualIntent: '片段被自动高亮标记的界面特写',
        durationMs: 4000,
        subtitleLines: ['AI 自动挑选高光片段，', '同步生成第一版字幕。']
    },
    {
        goal: '占位（设计稿乱码）',
        script: '是的发送到asdfasdfasdf\n阿斯顿发送到发的阿',
        visualIntent: '占位',
        durationMs: 3900,
        subtitleLines: ['是的发送到asdfasdfasdf', '阿斯顿发送到发的阿']
    },
    {
        goal: '占位（设计稿乱码）',
        script: '是的发送到\n官方去潍坊过去问\n是的发送到发的岗位工区',
        visualIntent: '占位',
        durationMs: 4100,
        subtitleLines: [
            '是的发送到',
            '官方去潍坊过去问',
            '是的发送到发的岗位工区'
        ]
    },
    {
        goal: '占位（设计稿乱码）',
        script: '阿斯顿发的\n刚刚我去二\n撒旦法水电费赶过去',
        visualIntent: '占位',
        durationMs: 4200,
        subtitleLines: ['阿斯顿发的', '刚刚我去二', '撒旦法水电费赶过去']
    },
    {
        goal: '占位（设计稿乱码）',
        script: '谁的法谁的规',
        visualIntent: '占位',
        durationMs: 3800,
        subtitleLines: ['谁的法谁的规']
    },
    {
        goal: '替换素材后自动重排',
        script: '把选中的片段替换成新素材，\n时间线会自动重新对齐。',
        visualIntent: '替换素材，后续片段整体平移',
        durationMs: 4500,
        subtitleLines: ['把选中的片段替换成新素材，', '时间线会自动重新对齐。']
    },
    {
        goal: '文稿驱动配音与字幕',
        script: '配音与字幕跟着文稿走，\n改一处两边同步更新。',
        visualIntent: '文稿面板与字幕轨联动',
        durationMs: 4000,
        subtitleLines: ['配音与字幕跟着文稿走，', '改一处两边同步更新。']
    },
    {
        goal: '收尾留白',
        script: '收尾留两秒空镜，\n方便接片尾。',
        visualIntent: '空镜，缓慢推进',
        durationMs: 4700,
        subtitleLines: ['收尾留两秒空镜，', '方便接片尾。']
    }
];

const pad2 = (n: number): string => String(n).padStart(2, '0');

/**
 * 按字符数把一段区间切成若干块。
 *
 * **先算各块的累计边界再相减**，而不是逐块取整后累加——后者会攒出舍入误差，
 * 最后一块对不上 scene 的右边界，直接违反不变量 5。
 */
function splitByWeight(
    startMs: number,
    durationMs: number,
    weights: readonly number[]
): { startMs: number; durationMs: number }[] {
    const total = weights.reduce((sum, w) => sum + w, 0);
    if (total <= 0 || weights.length === 0) return [{ startMs, durationMs }];

    const out: { startMs: number; durationMs: number }[] = [];
    let consumed = 0;
    let cursor = startMs;
    for (let i = 0; i < weights.length; i += 1) {
        consumed += weights[i]!;
        const isLast = i === weights.length - 1;
        // 最后一块直接顶到右边界，把所有舍入残差都吸收掉
        const edge = isLast
            ? startMs + durationMs
            : startMs + Math.round((durationMs * consumed) / total);
        out.push({ startMs: cursor, durationMs: edge - cursor });
        cursor = edge;
    }
    return out.filter((block) => block.durationMs > 0);
}

function buildProject(): VideoProject {
    const assets: Record<string, unknown> = {};
    const scenes: unknown[] = [];
    const videoClips: unknown[] = [];
    const voiceClips: unknown[] = [];
    const subtitleClips: unknown[] = [];

    let cursorMs = 0;

    sceneSpecs.forEach((spec, index) => {
        const no = pad2(index + 1);
        const sceneId = `scene_${no}`;
        const videoAssetId = `asset_v${no}`;
        const voiceAssetId = `asset_a${no}`;
        const videoClipId = `clip_v${no}`;
        const voiceClipId = `clip_a${no}`;

        // 源片比用到的区间长，裁切点落在中段——符合"从长素材里取一段"的真实情形
        const sourceDurationMs = spec.durationMs + 6000;
        const inMs = 1200;

        assets[videoAssetId] = {
            kind: 'video',
            path: `media/shot-${no}.mp4`,
            absolutePath: null,
            hash: `sha256:video-${no}`,
            durationMs: sourceDurationMs,
            width: 1920,
            height: 1080,
            fps: 30
        };
        assets[voiceAssetId] = {
            kind: 'audio',
            path: `audio/voice-${no}.wav`,
            absolutePath: null,
            hash: `sha256:voice-${no}`,
            durationMs: spec.durationMs
        };

        const blocks = splitByWeight(
            cursorMs,
            spec.durationMs,
            spec.subtitleLines.map((line) => Math.max(1, line.length))
        );
        const sceneSubtitleIds = blocks.map(
            (_, i) => `clip_s${no}_${pad2(i + 1)}`
        );

        scenes.push({
            id: sceneId,
            index,
            goal: spec.goal,
            script: spec.script,
            scriptHash: `sha256:script-${no}`,
            visualIntent: spec.visualIntent,
            startMs: cursorMs,
            durationMs: spec.durationMs,
            refs: {
                video: videoClipId,
                voice: [voiceClipId],
                subtitle: sceneSubtitleIds
            }
        });

        videoClips.push({
            kind: 'video',
            id: videoClipId,
            sceneId,
            assetId: videoAssetId,
            // 不做变速，所以 outMs - inMs 必须恰好等于 durationMs
            inMs,
            outMs: inMs + spec.durationMs,
            startMs: cursorMs,
            durationMs: spec.durationMs,
            crop: { anchorX: 0.5, anchorY: 0.5 },
            transform: { scale: 1, x: 0, y: 0 },
            transitions: { in: 'none', out: 'cut' }
        });

        voiceClips.push({
            kind: 'voice',
            id: voiceClipId,
            sceneId,
            assetId: voiceAssetId,
            startMs: cursorMs,
            durationMs: spec.durationMs,
            // 整段播放：源内区间就是 0 .. 时长（schema v2）
            inMs: 0,
            outMs: spec.durationMs,
            // 送进 TTS 的就是分镜的 script，一个字都不差
            text: spec.script,
            gainDb: 0,
            provider: {
                name: 'mock',
                model: 'mock-tts',
                voiceId: 'zh_female_gaolengyujie_uranus_bigtts'
            }
        });

        blocks.forEach((block, i) => {
            subtitleClips.push({
                kind: 'subtitle',
                id: sceneSubtitleIds[i],
                sceneId,
                startMs: block.startMs,
                durationMs: block.durationMs,
                text: spec.subtitleLines[i] ?? '',
                styleRef: 'subtitle_default'
            });
        });

        cursorMs += spec.durationMs;
    });

    const totalMs = cursorMs;

    assets['asset_m01'] = {
        kind: 'music',
        path: 'music/eutopia.mp3',
        absolutePath: null,
        hash: 'sha256:music-01',
        durationMs: 121_000
    };

    return videoProjectSchema.parse({
        // 跟着当前版本走，不写死——理由同 packages/video-project 的 fixtures
        schemaVersion: CURRENT_SCHEMA_VERSION,
        project: {
            id: 'prj_editor_demo',
            title: '口播短片自动剪辑工程',
            sourcePrompt: '做一条讲前端如何进阶 AI 的口播短片',
            createdAt: '2026-09-22T10:00:00+08:00',
            updatedAt: '2026-09-22T10:42:11+08:00'
        },
        canvas: {
            width: 1920,
            height: 1080,
            fps: 30,
            durationMs: totalMs,
            safeArea: { bottom: 120 }
        },
        assets,
        scenes,
        tracks: [
            { id: 'track_video', kind: 'video', clips: videoClips },
            { id: 'track_voice', kind: 'voice', clips: voiceClips },
            { id: 'track_subtitle', kind: 'subtitle', clips: subtitleClips },
            {
                id: 'track_music',
                kind: 'music',
                clips: [
                    {
                        kind: 'music',
                        id: 'clip_m01',
                        assetId: 'asset_m01',
                        startMs: 0,
                        // 不变量 6：音乐必须覆盖 [0, durationMs]
                        durationMs: totalMs,
                        gainDb: -18,
                        fade: { inMs: 800, outMs: 1500 },
                        ducking: {
                            enabled: true,
                            targetDb: -24,
                            attackMs: 120,
                            releaseMs: 400
                        }
                    }
                ]
            }
        ],
        styles: {
            subtitle_default: {
                fontFamily: 'Noto Sans SC',
                fontSize: 42,
                fontWeight: 700,
                color: '#FFFFFF',
                stroke: { color: '#000000', width: 4 },
                align: 'center'
            }
        },
        render: {
            container: 'mp4',
            videoCodec: 'h264',
            audioCodec: 'aac',
            bitrateKbps: 8000,
            preset: 'medium'
        },
        ai: {
            runId: 'run_editor_demo',
            graphVersion: '1.0.0',
            approvals: [],
            decisions: [],
            failures: []
        }
    });
}

/**
 * 模块级单例。工程在这一版里是只读的，没必要每次渲染重建——
 * 重建会让 `useMemo` 的依赖每次都变，投影也就白缓存了。
 */
export const editorProject: VideoProject = buildProject();

/** 当前选中的分镜序号（0 基）。设计稿里高亮的是分镜 02 */
export const CURRENT_SCENE_INDEX = 1;
