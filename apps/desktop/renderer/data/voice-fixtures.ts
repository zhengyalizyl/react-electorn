// 本文件的内容逐字取自 magicut-demo.pen 的 frame UuBmw（妙剪 Magicut — 口播-画面）
// 的 Right Panel — 配置区（YvwNh）。接真实音色服务前整体替换。

// 与 ShotState 同一套写法：用联合字面量而不是 `selected?: boolean`，
// 把状态收敛成有限且可穷尽的几种。
export type VoiceState = 'idle' | 'selected';

export interface Voice {
    id: string;
    name: string;
    desc: string;
    /** 头像底色由数据驱动，不能拼成 Tailwind 类名（扫描不到），只能走内联 style */
    color: string;
    state: VoiceState;
}

export const voices = [
    {
        id: 'voice-xiaochen',
        name: '晓晨',
        desc: '知性女声 · 普通话',
        color: '#7C5CFF',
        state: 'selected'
    },
    {
        id: 'voice-yunze',
        name: '云泽',
        desc: '沉稳男声 · 普通话',
        color: '#2F7BFF',
        state: 'idle'
    },
    {
        id: 'voice-xiaoya',
        name: '小雅',
        desc: '甜美女声 · 普通话',
        color: '#FF6A9A',
        state: 'idle'
    },
    {
        id: 'voice-yiyang',
        name: '亦扬',
        desc: '活力男声 · 普通话',
        color: '#1FA588',
        state: 'idle'
    },
    {
        id: 'voice-ruoxi',
        name: '若曦',
        desc: '温柔女声 · 粤语',
        color: '#F5A524',
        state: 'idle'
    }
    // satisfies 而不是 as：校验形状但不把字面量拓宽成 string
] as const satisfies readonly Voice[];

/** 设计稿画的是选中「晓晨」那一帧 */
export const DEFAULT_VOICE_ID = voices[0].id;

export interface VoiceParam {
    /** 状态里的键。用联合字面量，少一个拼错的机会 */
    key: 'volume' | 'speed';
    label: string;
    /** 默认填充百分比。设计稿填充宽 233/291 与 146/291，换算后与容器宽度解耦 */
    percent: number;
    /**
     * 百分比 → 右侧读数。
     *
     * 滑杆动了读数就得跟着动，所以读数不能再是写死的字符串。
     * 两条参数的量纲不一样（一个是百分比本身，一个是倍率），
     * 各自带自己的换算，比在组件里 if 一遍清楚。
     */
    format: (percent: number) => string;
}

/** 语速按 0.5x–1.5x 铺开：设计稿的 50% 正好落在 1.0x 上 */
export function speedLabel(percent: number): string {
    return `${(0.5 + percent / 100).toFixed(1)}x`;
}

export const voiceParams: readonly VoiceParam[] = [
    { key: 'volume', label: '音量', percent: 80, format: (p) => `${p}%` },
    { key: 'speed', label: '语速', percent: 50, format: speedLabel }
];

/** 两条滑杆的位置（0–100）。预览按它播，所以由页面持有 */
export interface VoiceParams {
    volume: number;
    speed: number;
}

/** 「重置」要回到的那一组值 */
export function defaultVoiceParams(): VoiceParams {
    return { volume: 80, speed: 50 };
}

/**
 * 滑杆位置 → 播放音量（0–1）。
 *
 * `<audio>.volume` 收的就是 0–1，所以这一步只是除以 100。
 * 单独写成函数是因为读数、预览、将来写进工程的 `gainDb` 都要用同一个换算，
 * 各算各的迟早会对不上。
 */
export function volumeToGain(percent: number): number {
    return Math.min(1, Math.max(0, percent / 100));
}

/**
 * 滑杆位置 → 播放倍速。
 *
 * 和读数用的是同一条映射（0.5x–1.5x），所以界面上写着 1.2x 就真的是 1.2 倍，
 * 不会出现"读数一套、实际播放另一套"。
 */
export function speedToRate(percent: number): number {
    return 0.5 + percent / 100;
}
