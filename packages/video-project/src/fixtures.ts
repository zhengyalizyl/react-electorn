import type { VideoProject } from './schema';
import { CURRENT_SCHEMA_VERSION, videoProjectSchema } from './schema';

/**
 * 一份合法的样例工程，供下游开发与测试使用。
 *
 * 两个分镜、四条轨道，满足全部七条不变量。改它时务必保持合法——
 * 下游所有测试都拿它当基准，它一旦失效会引起连锁误报。
 *
 * 时间安排：scene_01 [0, 8200)，scene_02 [8200, 14000)，总长 14000。
 */
const raw = {
    // 跟着当前版本走，不写死：写死的话每次升版这份基准就变成"旧工程"，
    // 下游那条「合法工程解析后 migrated 为 false」的断言会莫名其妙地红
    schemaVersion: CURRENT_SCHEMA_VERSION,
    project: {
        id: 'prj_sample',
        title: '示例工程',
        sourcePrompt: '讲讲前端如何转型 AI',
        createdAt: '2026-09-22T10:00:00+08:00',
        updatedAt: '2026-09-22T10:42:11+08:00'
    },
    canvas: {
        width: 1920,
        height: 1080,
        fps: 30,
        durationMs: 14000,
        safeArea: { bottom: 120 }
    },
    assets: {
        asset_v01: {
            kind: 'video',
            path: 'media/office-01.mp4',
            absolutePath: null,
            hash: 'sha256:aaa',
            durationMs: 15200,
            width: 1920,
            height: 1080,
            fps: 30
        },
        asset_v02: {
            kind: 'video',
            path: 'media/code-02.mp4',
            absolutePath: null,
            hash: 'sha256:bbb',
            durationMs: 9000,
            width: 1920,
            height: 1080,
            fps: 30
        },
        asset_a01: {
            kind: 'audio',
            path: 'audio/tts_01.wav',
            absolutePath: null,
            hash: 'sha256:ccc',
            durationMs: 8200
        },
        asset_a02: {
            kind: 'audio',
            path: 'audio/tts_02.wav',
            absolutePath: null,
            hash: 'sha256:ddd',
            durationMs: 5800
        },
        asset_m01: {
            kind: 'music',
            path: 'music/eutopia.mp3',
            absolutePath: null,
            hash: 'sha256:eee',
            durationMs: 121000
        }
    },
    scenes: [
        {
            id: 'scene_01',
            index: 0,
            goal: '开场抛问题，制造好奇',
            script: '大家好，很多前端同学现在都在焦虑一件事。',
            scriptHash: 'sha256:s1',
            visualIntent: '开放式办公区，人物专注工作的中景',
            startMs: 0,
            durationMs: 8200,
            refs: {
                video: 'clip_v01',
                voice: ['clip_a01'],
                subtitle: ['clip_s01', 'clip_s02']
            },
            aiNotes: '画面语境与开场问题契合'
        },
        {
            id: 'scene_02',
            index: 1,
            goal: '给出学习路线的第一步',
            script: '第一步，先把工程能力补齐。',
            scriptHash: 'sha256:s2',
            visualIntent: '代码编辑器特写',
            startMs: 8200,
            durationMs: 5800,
            refs: {
                video: 'clip_v02',
                voice: ['clip_a02'],
                subtitle: ['clip_s03']
            }
        }
    ],
    tracks: [
        {
            id: 'track_video',
            kind: 'video',
            clips: [
                {
                    kind: 'video',
                    id: 'clip_v01',
                    sceneId: 'scene_01',
                    assetId: 'asset_v01',
                    inMs: 1200,
                    outMs: 9400,
                    startMs: 0,
                    durationMs: 8200,
                    crop: { anchorX: 0.62, anchorY: 0.5 },
                    transform: { scale: 1, x: 0, y: 0 },
                    transitions: { in: 'none', out: 'cut' }
                },
                {
                    kind: 'video',
                    id: 'clip_v02',
                    sceneId: 'scene_02',
                    assetId: 'asset_v02',
                    inMs: 0,
                    outMs: 5800,
                    startMs: 8200,
                    durationMs: 5800,
                    crop: { anchorX: 0.5, anchorY: 0.5 },
                    transform: { scale: 1, x: 0, y: 0 },
                    transitions: { in: 'none', out: 'cut' }
                }
            ]
        },
        {
            id: 'track_voice',
            kind: 'voice',
            clips: [
                {
                    kind: 'voice',
                    id: 'clip_a01',
                    // 和 scene_01 的 script 一模一样——展示的就是送进 TTS 的
                    text: '大家好，很多前端同学现在都在焦虑一件事。',
                    sceneId: 'scene_01',
                    assetId: 'asset_a01',
                    startMs: 0,
                    durationMs: 8200,
                    // 整段播放：源内区间就是 0 .. 时长
                    inMs: 0,
                    outMs: 8200,
                    gainDb: 0,
                    provider: {
                        name: 'mock',
                        model: 'mock-tts',
                        voiceId: 'voice-wanwan'
                    }
                },
                {
                    kind: 'voice',
                    id: 'clip_a02',
                    text: '第一步，先把工程能力补齐。',
                    sceneId: 'scene_02',
                    assetId: 'asset_a02',
                    startMs: 8200,
                    durationMs: 5800,
                    inMs: 0,
                    outMs: 5800,
                    gainDb: 0,
                    provider: {
                        name: 'mock',
                        model: 'mock-tts',
                        voiceId: 'voice-wanwan'
                    }
                }
            ]
        },
        {
            id: 'track_subtitle',
            kind: 'subtitle',
            clips: [
                {
                    kind: 'subtitle',
                    id: 'clip_s01',
                    sceneId: 'scene_01',
                    startMs: 0,
                    durationMs: 4000,
                    text: '大家好，很多前端同学',
                    styleRef: 'subtitle_default'
                },
                {
                    kind: 'subtitle',
                    id: 'clip_s02',
                    sceneId: 'scene_01',
                    startMs: 4200,
                    durationMs: 4000,
                    text: '现在都在焦虑一件事',
                    styleRef: 'subtitle_default'
                },
                {
                    kind: 'subtitle',
                    id: 'clip_s03',
                    sceneId: 'scene_02',
                    startMs: 8200,
                    durationMs: 5800,
                    text: '第一步，先把工程能力补齐',
                    styleRef: 'subtitle_default'
                }
            ]
        },
        {
            id: 'track_music',
            kind: 'music',
            clips: [
                {
                    kind: 'music',
                    id: 'clip_m01',
                    assetId: 'asset_m01',
                    startMs: 0,
                    durationMs: 14000,
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
        runId: 'run_sample',
        graphVersion: '1.0.0',
        approvals: [],
        decisions: [
            {
                sceneId: 'scene_01',
                node: 'AssetMatcher',
                chosen: 'asset_v01',
                reason: '开放式办公区画面与开场语境契合，且有 15.2s 可裁',
                alternatives: [
                    {
                        assetId: 'asset_v02',
                        score: 0.71,
                        rejected: '代码特写与开场问题不匹配'
                    }
                ]
            }
        ],
        failures: []
    }
};

/** 每次调用返回一份全新的深拷贝，避免测试之间互相污染 */
export function sampleProject(): VideoProject {
    return videoProjectSchema.parse(structuredClone(raw));
}
