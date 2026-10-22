// 本文件的内容逐字取自 magicut-demo.pen 的 frame kqZiT（妙剪 Magicut — Editor-画面）。
//
// B2 之后这里只剩**与时间线无关**的展示文案。原先的 shots / videoClips /
// voiceClips / rulerMarks 已全部移除：它们是纯像素的视觉 mockup，造不出合法工程
// （9 个分镜只配了 2 段配音、标尺刻度与片段宽度的时间尺度对不上）。
// 时间线与分镜列表现在由 `editor-project.ts` 的真实工程投影而来。

export interface SegmentChip {
    key: string;
    value: string;
}

export const segmentChips = [
    { key: '视频画面', value: '智能匹配素材' },
    { key: '旁白配音', value: '涵映字幕' },
    { key: '创作倾向', value: 'AI智能创作（默认）' }
] as const satisfies readonly SegmentChip[];
