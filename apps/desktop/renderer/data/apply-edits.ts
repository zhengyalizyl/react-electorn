import type { VideoProject } from '@magicut-react-demo/video-project';

import {
    baseStyleEntryOf,
    resolveSubtitleStyle,
    type SubtitleSettings
} from '@/renderer/data/subtitle-style';
import type { VoiceParams } from '@/renderer/data/voice-fixtures';
import { percentToGainDb } from '@/renderer/data/voice-settings';

/**
 * 把界面上的编辑盖回工程，得到"用户现在看到的那份片子"。
 *
 * ## 为什么需要它
 *
 * 字幕样式和音量走的是**按字段存**的路径（只写 `styles` 或只写 `gainDb`），
 * 而分割改的是结构，只能**整份写回去**。两条路径同时存在时，
 * 整份那次如果用的是没盖过编辑的底稿，就会把刚才按字段存进去的改动抹掉——
 * 表现为"改了颜色、切一刀、颜色又变回去了"，而且中间没有任何报错。
 *
 * 所以整份写回去之前先过这里：**写下去的就是用户看到的**。
 */
export function applyEdits(
    project: VideoProject,
    edits: { subtitle: SubtitleSettings; voice: VoiceParams }
): VideoProject {
    const { id: styleId, style: base } = baseStyleEntryOf(project);
    const gainDb = percentToGainDb(edits.voice.volume);

    return {
        ...project,
        ...(styleId === null
            ? {}
            : {
                  styles: {
                      ...project.styles,
                      [styleId]: resolveSubtitleStyle(base, edits.subtitle)
                  }
              }),
        tracks: project.tracks.map((track) =>
            track.kind === 'voice'
                ? {
                      ...track,
                      clips: track.clips.map((clip) => ({ ...clip, gainDb }))
                  }
                : track
        )
    };
}
