// 色卡的配色与文案逐字取自 magicut-demo.pen 的 frame DJZgj（妙剪 Magicut — 字幕-画面）
// 的 Right Panel — 配置区（lr2Fs）。

/**
 * 一张字幕样式色卡。
 *
 * ## 为什么带描边而不只是颜色
 *
 * 七张卡里有四张的名字就是在说描边——「白字黑边」「白字细边」「红字白边」
 * 与「白字」的区别**全在描边上**，三张卡的 `color` 都是白的。
 * 只存颜色的话，这三张在预览里长得一模一样，点哪张都一样。
 *
 * 描边宽度的单位是**成片画布上的像素**，和工程里 `SubtitleStyle.stroke.width`
 * 同一套单位——两边不同单位的话，色卡选出来的粗细和工程里存的对不上。
 */
export interface StyleSwatch {
    id: string;
    /** 既是可达名称也是底部那行「当前样式」的文案 */
    label: string;
    /** 色卡里那个 T 的颜色，由数据驱动，只能走内联 style */
    color: string;
    /** 描边。null = 不描边 */
    stroke: { color: string; width: number } | null;
}

export const styleSwatches = [
    {
        id: 'swatch-white-outline',
        label: '白字黑边',
        color: '#FFFFFF',
        stroke: { color: '#000000', width: 4 }
    },
    { id: 'swatch-white', label: '白字', color: '#FFFFFF', stroke: null },
    {
        id: 'swatch-yellow',
        label: '黄字',
        color: '#F6C453',
        stroke: { color: '#000000', width: 4 }
    },
    {
        id: 'swatch-pink',
        label: '粉字',
        color: '#FF6FA3',
        stroke: { color: '#000000', width: 4 }
    },
    {
        id: 'swatch-white-thin',
        label: '白字细边',
        color: '#F2F2F5',
        stroke: { color: '#000000', width: 2 }
    },
    {
        id: 'swatch-red-outline',
        label: '红字白边',
        color: '#E5405A',
        stroke: { color: '#FFFFFF', width: 4 }
    },
    {
        id: 'swatch-blue',
        label: '蓝字',
        color: '#4FA3FF',
        stroke: { color: '#000000', width: 4 }
    }
    // satisfies 而不是 as：校验形状但不把字面量拓宽成 string
] as const satisfies readonly StyleSwatch[];

/** 设计稿画的是选中「白字黑边」那一帧 */
export const DEFAULT_SWATCH_ID: string = styleSwatches[0].id;

export function swatchById(id: string): StyleSwatch | undefined {
    return styleSwatches.find((swatch) => swatch.id === id);
}

/**
 * 字号的取值范围。
 *
 * 设计稿只给了两个数：填充 20%、读数 24 px。两者同时成立意味着下限 12、上限 72
 * （12 + 60 × 20% = 24）——**这个区间是从设计稿反推出来的，不是拍的**，
 * 所以改任何一头都会让滑杆回不到设计稿那一帧。
 */
export const FONT_SIZE_MIN = 12;
export const FONT_SIZE_MAX = 72;

/** 滑杆位置 → 字号。整数像素：小数号在字幕上没有意义，读数也难看 */
export function percentToFontSize(percent: number): number {
    return Math.round(
        FONT_SIZE_MIN + ((FONT_SIZE_MAX - FONT_SIZE_MIN) * percent) / 100
    );
}

/**
 * 字号 → 滑杆位置。
 *
 * 工程里的字号是任意值（示例工程是 42），**夹在区间里**而不是让滑杆跑到
 * 轨道外面去——超出范围时手柄会画在容器外，看着像渲染坏了。
 */
export function fontSizeToPercent(px: number): number {
    const clamped = Math.min(FONT_SIZE_MAX, Math.max(FONT_SIZE_MIN, px));
    return Math.round(
        ((clamped - FONT_SIZE_MIN) / (FONT_SIZE_MAX - FONT_SIZE_MIN)) * 100
    );
}

export function fontSizeLabel(percent: number): string {
    return `${percentToFontSize(percent)} px`;
}

/** 设计稿滑杆填充 53/263，263 = 323 − 面板 padding 32 − 卡片 padding 28 */
export const fontSizePercent = 20;

export const FONT_SIZE_VALUE = fontSizeLabel(fontSizePercent);

export const APPLY_HINT = '应用到当前字幕轨';
