import type { CSSProperties } from 'react';

import type {
    SubtitleStyle,
    VideoProject
} from '@magicut-react-demo/video-project';

import {
    DEFAULT_SWATCH_ID,
    fontSizePercent,
    percentToFontSize,
    styleSwatches,
    swatchById
} from '@/renderer/data/subtitle-fixtures';

/**
 * 字幕样式：**工程里那份说了算**。
 *
 * ## 之前错在哪
 *
 * 工程 JSON 里本来就有 `styles.subtitle_default`（示例工程是 42px、白字、
 * 4px 黑描边），而预览把字幕写死成 `14px / 白 / 一层柔和投影`——
 * 两边各说各的。于是右侧面板点了色卡，预览纹丝不动，
 * 而且**就算不点，预览显示的也从来不是工程里存的那个样式**。
 *
 * 所以这里不是"把面板的状态接到预览"，而是让面板和预览**认同一份
 * `SubtitleStyle`**：面板编辑它，预览渲染它。
 */

/**
 * 界面上正在编辑的字幕设置。
 *
 * 只存**用户能改的那几项**，其余（字体、字重、对齐）跟着底稿走——
 * 面板上没有改它们的入口，存一份只会多一处和工程对不上的地方。
 */
export interface SubtitleSettings {
    /** 选中的色卡 id。色卡定颜色与描边 */
    swatchId: string;
    /** 成片画布上的字号（px），和工程里 `SubtitleStyle.fontSize` 同一套单位 */
    fontSizePx: number;
    /** 「显示字幕」开关 */
    visible: boolean;
}

/**
 * 没有工程时的底稿。
 *
 * 字体与字重照 `sampleProject` 的那份写，字号用设计稿面板上的 24px——
 * 这条分支只在 `/editor` 无 id 的设计稿预览里走到，那时候预览区本来就没有字幕，
 * 所以这个 24 只影响面板上的读数。
 */
export const DESIGN_SUBTITLE_STYLE: SubtitleStyle = {
    fontFamily: 'Noto Sans SC',
    fontSize: percentToFontSize(fontSizePercent),
    fontWeight: 700,
    color: '#FFFFFF',
    stroke: { color: '#000000', width: 4 },
    align: 'center'
};

/**
 * 工程里的字幕底稿，**连同它的 id**。
 *
 * id 是落盘时要的：保存走的是「改第 `id` 条样式」，而不是「把 styles 整个换掉」。
 * 没有工程（设计稿预览）时 id 是 null——那种情况本来也无处可写。
 *
 * 取第一条：P1 的工程只有 `subtitle_default` 一条，而且所有字幕片段都引用它。
 * 真有多条样式时这里要改成按当前片段的 `styleRef` 取，
 * 但那得先有"按片段分别设样式"的入口，现在没有。
 */
export function baseStyleEntryOf(project: VideoProject | undefined): {
    id: string | null;
    style: SubtitleStyle;
} {
    const entry = Object.entries(project?.styles ?? {})[0];
    return entry
        ? { id: entry[0], style: entry[1] }
        : { id: null, style: DESIGN_SUBTITLE_STYLE };
}

/** 工程里的字幕底稿。拿不到就用设计稿那份 */
export function baseStyleOf(project: VideoProject | undefined): SubtitleStyle {
    return baseStyleEntryOf(project).style;
}

/**
 * 一份样式对应哪张色卡。
 *
 * 比的是颜色与描边——色卡本来就只定这两样。工程用的配色不在七张卡里时返回
 * undefined，面板上**一张都不高亮**：硬认一张最近的，等于告诉用户
 * "当前是黄字"，而画面上明明不是。
 */
export function swatchIdForStyle(style: SubtitleStyle): string | undefined {
    const same = (a: string, b: string): boolean =>
        a.toUpperCase() === b.toUpperCase();

    return styleSwatches.find((swatch) => {
        if (!same(swatch.color, style.color)) return false;
        if (swatch.stroke === null) return style.stroke === undefined;
        return (
            style.stroke !== undefined &&
            same(swatch.stroke.color, style.stroke.color) &&
            swatch.stroke.width === style.stroke.width
        );
    })?.id;
}

/** 打开一个工程时，面板该停在哪一档 */
export function settingsFromProject(
    project: VideoProject | undefined
): SubtitleSettings {
    const base = baseStyleOf(project);
    return {
        swatchId: swatchIdForStyle(base) ?? DEFAULT_SWATCH_ID,
        fontSizePx: base.fontSize,
        visible: true
    };
}

/** 底稿 + 面板上改过的那几项 = 真正要渲染的样式 */
export function resolveSubtitleStyle(
    base: SubtitleStyle,
    settings: SubtitleSettings
): SubtitleStyle {
    const swatch = swatchById(settings.swatchId);
    if (!swatch) {
        return { ...base, fontSize: settings.fontSizePx };
    }

    // `exactOptionalPropertyTypes` 下不能显式赋 undefined，没描边就不带这个键
    const { stroke: _dropped, ...rest } = base;
    void _dropped;
    return {
        ...rest,
        fontSize: settings.fontSizePx,
        color: swatch.color,
        ...(swatch.stroke ? { stroke: { ...swatch.stroke } } : {})
    };
}

/**
 * 两份样式是不是同一份。
 *
 * 落盘前要拿它挡一道：界面刚打开时算出来的样式和工程里存的**本来就一样**，
 * 不比一下的话每次打开工程都会白写一次 `project.json`。
 */
export function sameSubtitleStyle(a: SubtitleStyle, b: SubtitleStyle): boolean {
    return (
        a.fontFamily === b.fontFamily &&
        a.fontSize === b.fontSize &&
        a.fontWeight === b.fontWeight &&
        a.color === b.color &&
        a.align === b.align &&
        (a.stroke?.color ?? null) === (b.stroke?.color ?? null) &&
        (a.stroke?.width ?? null) === (b.stroke?.width ?? null)
    );
}

/**
 * 八向投影描边。
 *
 * CSS 里给文字描边只有两条路：`-webkit-text-stroke` 会把笔画从**内侧**吃掉，
 * 中文细笔画上尤其明显（「言」字旁会糊成一团）；八个方向各投一次影不吃笔画，
 * 代价是字符串长一点。成片那头是 ffmpeg 画的，本来就是向外描边，
 * 所以**投影这条更接近成片的样子**。
 */
function strokeShadow(color: string, widthCqh: number): string {
    const w = widthCqh.toFixed(3);
    const n = (-widthCqh).toFixed(3);
    const z = '0';
    return [
        [n, n],
        [z, n],
        [w, n],
        [n, z],
        [w, z],
        [n, w],
        [z, w],
        [w, w]
    ]
        .map(([x, y]) => `${x}cqh ${y}cqh 0 ${color}`)
        .join(', ');
}

/**
 * 字幕在**预览框里**长什么样。
 *
 * ## 为什么要换算，不能照搬
 *
 * 工程里的 `fontSize` 是**成片画布上的像素**——示例工程是 1080 高画布上的
 * 42px，占画面高度的 3.9%。预览框只有几百像素高，照搬 42px 会糊掉半个画面；
 * 反过来写死 14px，则是换个画布尺寸就全错。
 *
 * ## 为什么用 cqh 而不是在 JS 里量
 *
 * `1cqh` = 容器高度的 1%，于是「占画面 3.9%」可以直接写成 `3.9cqh`，
 * 预览框多大都对，窗口缩放时浏览器自己重算。在 JS 里量尺寸的话，
 * 要挂 ResizeObserver、要处理首帧还没布局完的那一下、还要防抖——
 * 全是为了算一个浏览器本来就会算的数。
 *
 * 代价是预览框必须声明 `container-type: size`（见 PreviewPanel），
 * **没有这一句的话 cqh 会退到视口高度去算**，字幕会大得离谱。
 */
export function subtitlePreviewStyle(
    style: SubtitleStyle,
    canvasHeight: number
): CSSProperties {
    // 画布高度拿不到或是 0 时退回 1080：除以 0 会得到 Infinity，
    // 那会让字幕撑满整个预览框，比"大小不准"糟得多
    const height = canvasHeight > 0 ? canvasHeight : 1080;
    const ratio = 100 / height;

    return {
        color: style.color,
        fontWeight: style.fontWeight,
        fontFamily: style.fontFamily,
        textAlign: style.align,
        fontSize: `${(style.fontSize * ratio).toFixed(3)}cqh`,
        // 没描边时留一层柔和投影：白字落在亮画面上会直接看不见
        textShadow: style.stroke
            ? strokeShadow(style.stroke.color, style.stroke.width * ratio)
            : '0 2px 6px #000000cc'
    };
}
