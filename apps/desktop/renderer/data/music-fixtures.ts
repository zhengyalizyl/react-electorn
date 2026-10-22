// 音乐面板的数据，合并自 magicut-demo.pen 的两张稿：
// - frame C1Sck（右侧音乐设置区）：行样式、配色、前 3 首（带作者）
// - frame m9jWt 的 Recommended Card（o6pBm）：完整的 7 首曲库、风格筛选、「使用中」徽标
//
// 两张稿的副信息维度不同：C1Sck 给的是作者，m9jWt 给的是题材。
// 合并后统一放进 credit 这一栏，没有凭空补过任何一方缺的字段。
// 接真实曲库前整体替换。

/** 封面渐变色站。C1Sck 的是两段，m9jWt 的是三段，所以收数组而不是定长元组 */
export type CoverGradient = readonly string[];

export interface Track {
    id: string;
    name: string;
    /** 副信息：作者（C1Sck）或题材（m9jWt），取决于哪张稿定义了它 */
    credit: string;
    /** 风格徽标原文，格式固定为「风格 · 节奏」 */
    style: string;
    duration: string;
    cover: CoverGradient;
}

export const tracks = [
    {
        id: 'track-eutopia',
        name: 'Eutopia',
        credit: 'Mika Chen',
        style: '平静 · 偏慢',
        duration: '02:01',
        cover: ['#F05F73', '#8B6AF7']
    },
    {
        id: 'track-canon',
        name: '卡农（经典钢琴版）',
        credit: 'Aiden Lin',
        style: '平静 · 偏快',
        duration: '01:43',
        cover: ['#D9A36F', '#7A5CF2']
    },
    {
        id: 'track-daily',
        name: '通用 日常 平和',
        credit: 'Nova Lab',
        style: '平静 · 适中',
        duration: '00:20',
        cover: ['#E43D30', '#111214']
    },
    {
        id: 'track-mikanbako',
        name: 'みかん箱-ひやむぎ、そーめ...',
        credit: '适合财经题材',
        style: '欢快 · 偏快',
        duration: '04:20',
        cover: ['#F6C453', '#F07A5A', '#8A5CFF']
    },
    {
        id: 'track-send-my-love',
        name: 'Send My Love',
        credit: '适合财经题材',
        style: '抒情 · 适中',
        duration: '02:05',
        cover: ['#E5405A', '#3A1E4A', '#2A2A44']
    },
    {
        id: 'track-mienkaisai',
        name: '面会菜',
        credit: '适合社会题材',
        style: '治愈 · 适中',
        duration: '01:15',
        cover: ['#3BB8A0', '#1E3A4A', '#F0587E']
    },
    {
        id: 'track-dance-for-me-wallis',
        name: 'Dance for Me Wallis',
        credit: '适合人文,社会题材',
        style: '悲壮 · 适中',
        duration: '01:35',
        cover: ['#F2C6D8', '#C24FE0', '#4A1E6E']
    },
    {
        id: 'track-moon-symphony',
        name: '月亮之上(交响乐版)',
        credit: '适合时政,人文题材',
        style: '宏伟 · 适中',
        duration: '02:30',
        cover: ['#1E1E28', '#2A2A44', '#7C5CFF']
    },
    {
        id: 'track-eternity',
        name: 'eternity',
        credit: '适合人文题材',
        style: '抒情 · 适中',
        duration: '03:12',
        cover: ['#3BB8A0', '#F6C453', '#F0587E']
    }
] as const satisfies readonly Track[];

export interface CurrentTrack {
    /** 指回 tracks 里的那一首，列表靠它标「使用中」 */
    id: string;
    name: string;
    /** 作者 · 风格 / 题材 */
    credit: string;
    /** 节奏 · 时长 · 对齐状态 */
    detail: string;
    /**
     * 封面渐变的色站。
     *
     * 设计稿给的初始曲目是三段（中间色停在 48%），而从推荐列表应用过来的
     * 曲目可能只有两段，所以这里收数组而不是定长元组。
     */
    cover: CoverGradient;
}

export const currentTrack = {
    id: 'track-eutopia',
    name: 'Eutopia',
    credit: 'Mika Chen · 平静 / 社会题材',
    detail: '偏慢 · 02:01 · 已对齐时间线',
    cover: ['#F05F73', '#F6B84B', '#8B6AF7']
} as const satisfies CurrentTrack;

// 取自 m9jWt 的那一组：C1Sck 的「励志 / 更多」在合并后的曲库里一首都筛不到。
// 注意「月亮之上(交响乐版)」的风格是「宏伟」，这六项都筛不到它，只有「全部」能看见。
export const genres = ['全部', '平静', '欢快', '抒情', '治愈', '悲壮'] as const;

/** 初始分类。筛选入口显示的也是它，之后跟着分类按钮走 */
/** 「不筛选」那一档。筛选入口清空筛选时回到它 */
export const ALL_GENRES = '全部';

export const ACTIVE_GENRE: string = ALL_GENRES;

/** 设计稿滑杆填充 156/260 */
export const volumePercent = 60;

export const VOLUME_VALUE = '60%';

/**
 * 封面渐变。
 *
 * 三段按设计稿把中间色停在中点；两段就是普通的首尾渐变——
 * 不同稿给的色站数不一样，不去凭空补齐。
 */
export function coverGradient(stops: CoverGradient): string {
    const [from, via, to] = stops;

    if (from && via && to) {
        return `linear-gradient(135deg, ${from} 0%, ${via} 50%, ${to} 100%)`;
    }

    return `linear-gradient(135deg, ${from ?? '#000'} 0%, ${via ?? from ?? '#000'} 100%)`;
}

/** 当前音乐封面：设计稿把三段的中间色停在 48%，与列表项的 50% 略有不同 */
export function currentCoverGradient(stops: CoverGradient): string {
    const [from, via, to] = stops;

    if (from && via && to) {
        return `linear-gradient(135deg, ${from} 0%, ${via} 48%, ${to} 100%)`;
    }

    return `linear-gradient(135deg, ${from ?? '#000'} 0%, ${via ?? from ?? '#000'} 100%)`;
}

/**
 * 把推荐列表里的一首曲子转成「当前音乐」卡要的形状。
 *
 * style 形如「平静 · 偏慢」，后半是节奏，单独提出来放进 detail。
 * credit 直接沿用，不去编造原稿没有的维度。
 */
export function toCurrentTrack(track: Track): CurrentTrack {
    const tempo = track.style.split(' · ')[1] ?? track.style;

    return {
        id: track.id,
        name: track.name,
        credit: `${track.credit} · ${track.style}`,
        detail: `${tempo} · ${track.duration} · 已对齐时间线`,
        cover: track.cover
    };
}
