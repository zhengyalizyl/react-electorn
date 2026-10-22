/**
 * 轨道片段的配色与波形——**纯表现，不属于工程数据**。
 *
 * VideoProject 里没有颜色字段，也不该有：颜色是编辑器怎么画的问题，
 * 换个皮肤不该改工程文件。所以这里按分镜序号取色，同一个分镜在任何缩放下都是同一色。
 *
 * 九组配色逐条取自 magicut-demo.pen 的 frame kqZiT，
 * 构成是「深底 + 中间色描边 + 亮色左沿条」。
 */

export interface ClipPalette {
    bg: string;
    border: string;
    edge: string;
}

const VIDEO_PALETTE: readonly ClipPalette[] = [
    { bg: '#0F3B33', border: '#1FA588', edge: '#22D3A0' },
    { bg: '#1B2E6E', border: '#2E4BB0', edge: '#4F7CFF' },
    { bg: '#3A2A6E', border: '#5B45A8', edge: '#9B7CFF' },
    { bg: '#5A2331', border: '#8A3548', edge: '#FF5A6E' },
    { bg: '#2A2A2E', border: '#3A3A40', edge: '#8A8A94' },
    { bg: '#3B2A16', border: '#8A5F2E', edge: '#F0A34B' },
    { bg: '#122E3B', border: '#1F6E8A', edge: '#3FC4E0' },
    { bg: '#2E1638', border: '#6B2E8A', edge: '#C46AF0' },
    { bg: '#16331F', border: '#2E8A4B', edge: '#4FE07C' }
];

/** 分镜数超过配色数就循环取用，不会出现没有颜色的片段 */
export function videoPaletteFor(sceneIndex: number | null): ClipPalette {
    const i = sceneIndex ?? 0;
    return VIDEO_PALETTE[
        ((i % VIDEO_PALETTE.length) + VIDEO_PALETTE.length) %
            VIDEO_PALETTE.length
    ]!;
}

/** 字符串 → 32 位整数。只用来做确定性伪随机，不做任何安全用途 */
function hashString(value: string): number {
    let hash = 2166136261;
    for (let i = 0; i < value.length; i += 1) {
        hash ^= value.charCodeAt(i);
        hash = Math.imul(hash, 16777619);
    }
    return hash >>> 0;
}

const BAR_MIN = 6;
const BAR_MAX = 24;

/**
 * 波形柱高。
 *
 * **由 clip id 确定性生成**，不用 `Math.random()`：随机的话每次渲染波形都在跳，
 * 而且测试没法断言。同一个 clip 永远是同一组柱高。
 *
 * 柱数按宽度算，一柱占 5px（0.5px 宽 + 3px 间隔，见 VoiceClip 的类名）。
 */
export function waveformBars(clipId: string, widthPx: number): number[] {
    const count = Math.max(0, Math.min(64, Math.floor((widthPx - 24) / 5)));
    let seed = hashString(clipId);
    return Array.from({ length: count }, () => {
        // xorshift32：够用、无依赖、跨平台结果一致
        seed ^= seed << 13;
        seed ^= seed >>> 17;
        seed ^= seed << 5;
        seed >>>= 0;
        return BAR_MIN + (seed % (BAR_MAX - BAR_MIN + 1));
    });
}

/**
 * 缩略图格数。
 *
 * 一格 28px 宽 + 8px 间距 = 36px；左侧的沿条、标签、右内边距合计约占 75px。
 * 剩下多少就画几格，上限 6 格——再多在一条片段里也看不清。
 */
export function thumbCountFor(widthPx: number): number {
    return Math.max(0, Math.min(6, Math.floor((widthPx - 75) / 36)));
}
