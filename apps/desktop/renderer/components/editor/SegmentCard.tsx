import { ChevronDown, ChevronUp } from 'lucide-react';
import { useState } from 'react';

import { isIndexTtsVoice } from '@magicut-react-demo/video-agent/custom-voices';
import { findVoice } from '@magicut-react-demo/video-agent/voices';
import type { VideoProject } from '@magicut-react-demo/video-project';
import { formatRange } from '@magicut-react-demo/video-project';

import Card from '@/renderer/components/editor/Card';
import Chip from '@/renderer/components/editor/Chip';
import IconButton from '@/renderer/components/editor/IconButton';
import { editorProject } from '@/renderer/data/editor-project';

/**
 * 当前分镜卡（画面模式配置区顶部）。
 *
 * **版式照设计稿**：标题「区间 + 分镜名」、一段文案、下面三条 `胶囊 + 说明`。
 *
 * ## 兜底必须和侧栏用同一份
 *
 * 没有工程时（`/editor` 无 id 的设计稿预览）退回**示例工程**，
 * 和 `ScriptSidebar` 一样。各退各的话，左边高亮「分镜 02 · 00:04-00:08」、
 * 右边却写着设计稿里那句「0:00-0:25 开场问题」——实跑截图就是这样，
 * 而「当前分镜」本该是左中右认同一个的东西。
 *
 * 三条胶囊对应三件事：**画面配了什么、旁白用谁的声音、字幕怎么排**。
 * 配不上素材的分镜是真实存在的状态（§6.1 的降级），那一行要如实说，
 * 不能装作有画面。
 */

/** 只显示文件名：完整路径又长又会暴露目录结构 */
function baseName(value: string): string {
    const parts = value.split(/[\\/]/).filter(Boolean);
    return parts[parts.length - 1] ?? value;
}

/**
 * 工程里存的音色 id → 给人看的名字。
 *
 * 官方音色查目录。自定义音色查不到，但**不能把 id 原样摆上去**：
 * `custom:index-tts2:vs_9f3a…` 是内部标识，用户没见过也看不懂，
 * 只会以为这一镜的配音出了什么毛病。
 *
 * 这里说不出具体是哪一条——样本名在音色库里，而那要走一次 IPC。
 * 为了画面模式一行说明把整个音色库拉进来不值当；想知道是哪一条，
 * 口播面板上选中的那行写着。
 *
 * 真·不认识的 id（旧工程、换过代次）仍然原样显示：那种时候
 * 那串字本身就是唯一的线索。
 */
function voiceLabel(voiceId: string): string {
    const known = findVoice(voiceId);
    if (known) return known.name;
    return isIndexTtsVoice(voiceId) ? '我的音色（本地复刻）' : voiceId;
}

interface SegmentCardProps {
    project?: VideoProject | undefined;
    sceneIndex?: number | undefined;
}

export default function SegmentCard({
    project,
    sceneIndex = 0
}: SegmentCardProps) {
    // 设计稿只画了展开那一帧。收起之后只留标题那一行，
    // 下面的创作过程就能往上提——面板矮的时候这是实打实的空间
    const [collapsed, setCollapsed] = useState(false);
    // 兜底和侧栏一致：退回示例工程，而不是另一份写死文案
    const source = project ?? editorProject;
    const scene = source.scenes[sceneIndex] ?? source.scenes[0];
    if (!scene) return null;

    const videoTrack = source.tracks.find((track) => track.kind === 'video');
    const clip = videoTrack?.clips.find((item) => item.sceneId === scene.id);
    const asset = clip ? source.assets[clip.assetId] : undefined;

    const voiceTrack = source.tracks.find((track) => track.kind === 'voice');
    const voiceClip = voiceTrack?.clips.find(
        (item) => item.sceneId === scene.id
    );
    /** 这一镜用的是谁的声音 */
    const voice = voiceClip ? voiceLabel(voiceClip.provider.voiceId) : '未生成';

    const subtitleTrack = source.tracks.find(
        (track) => track.kind === 'subtitle'
    );
    const subtitleCount =
        subtitleTrack?.clips.filter((item) => item.sceneId === scene.id)
            .length ?? 0;

    const rows = [
        {
            key: '视频画面',
            value: asset?.absolutePath
                ? baseName(asset.absolutePath)
                : // 配不上素材是真实状态，别装作有画面
                  '未匹配到素材，这一镜只有配音'
        },
        { key: '旁白配音', value: voice },
        {
            key: '字幕',
            value:
                subtitleCount === 0
                    ? '这一镜没有字幕'
                    : `${subtitleCount} 段，已对齐本镜时间轴`
        }
    ];

    return (
        <Card className="gap-2.5">
            <div className="flex w-full items-center justify-between">
                <h3
                    aria-label="当前分镜"
                    className="text-ed-lg font-bold text-ed-text"
                >
                    {formatRange(scene.startMs, scene.durationMs)} 分镜{' '}
                    {String(sceneIndex + 1).padStart(2, '0')}
                </h3>
                <IconButton
                    icon={collapsed ? ChevronUp : ChevronDown}
                    label={collapsed ? '展开分段' : '收起分段'}
                    onClick={() => setCollapsed((value) => !value)}
                    className="text-ed-text-2"
                />
            </div>

            {collapsed ? null : (
                <>
                    <p className="w-full text-ed-base leading-ed-tight text-ed-text-2">
                        {scene.script}
                    </p>

                    <div className="flex w-full flex-col gap-2">
                        {rows.map((row) => (
                            <div
                                key={row.key}
                                className="flex items-center gap-2.5"
                            >
                                <Chip className="shrink-0 text-ed-sm text-ed-text">
                                    {row.key}
                                </Chip>
                                <span className="text-ed-sm text-ed-text-3">
                                    {row.value}
                                </span>
                            </div>
                        ))}
                    </div>
                </>
            )}
        </Card>
    );
}
