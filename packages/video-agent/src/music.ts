/**
 * 背景音乐选择（B8，P1 简化版）。
 *
 * P1 只从**固定内置曲库**里选，不生成、不检索外部曲库。理由是音乐版权与曲库接入
 * 是独立的一摊事，不该挡住整条流水线跑通。
 *
 * 选择是**纯函数且确定性的**：同样的输入永远选出同一首。否则每次重跑工程
 * 配乐都在变，用户会以为是 bug。
 */

export type Mood = '平静' | '欢快' | '抒情' | '治愈' | '悲壮' | '宏伟';

export type Tempo = '偏慢' | '适中' | '偏快';

export interface MusicTrackSpec {
    id: string;
    name: string;
    /** 相对工程目录的路径 */
    path: string;
    durationMs: number;
    mood: Mood;
    tempo: Tempo;
    /** 题材倾向。设计稿里写在副信息栏的「适合 XX 题材」 */
    topics: readonly string[];
}

/**
 * 内置曲库，九首，取自 `magicut-demo.pen` 的音乐面板。
 *
 * `style` 那一栏原文格式是「情绪 · 节奏」，这里拆成两个字段——
 * 匹配时要分别比对，留成一个字符串就得每次 split。
 */
export const BUILTIN_MUSIC_LIBRARY: readonly MusicTrackSpec[] = [
    {
        id: 'track-eutopia',
        name: 'Eutopia',
        path: 'music/eutopia.mp3',
        durationMs: 121_000,
        mood: '平静',
        tempo: '偏慢',
        topics: ['社会']
    },
    {
        id: 'track-canon',
        name: '卡农（经典钢琴版）',
        path: 'music/canon.mp3',
        durationMs: 103_000,
        mood: '平静',
        tempo: '偏快',
        topics: ['人文']
    },
    {
        id: 'track-daily',
        name: '通用 日常 平和',
        path: 'music/daily.mp3',
        durationMs: 20_000,
        mood: '平静',
        tempo: '适中',
        topics: ['日常']
    },
    {
        id: 'track-mikanbako',
        name: 'みかん箱',
        path: 'music/mikanbako.mp3',
        durationMs: 260_000,
        mood: '欢快',
        tempo: '偏快',
        topics: ['财经']
    },
    {
        id: 'track-send-my-love',
        name: 'Send My Love',
        path: 'music/send-my-love.mp3',
        durationMs: 125_000,
        mood: '抒情',
        tempo: '适中',
        topics: ['财经']
    },
    {
        id: 'track-mienkaisai',
        name: '面会菜',
        path: 'music/mienkaisai.mp3',
        durationMs: 75_000,
        mood: '治愈',
        tempo: '适中',
        topics: ['社会']
    },
    {
        id: 'track-dance-for-me-wallis',
        name: 'Dance for Me Wallis',
        path: 'music/dance-for-me-wallis.mp3',
        durationMs: 95_000,
        mood: '悲壮',
        tempo: '适中',
        topics: ['人文', '社会']
    },
    {
        id: 'track-moon-symphony',
        name: '月亮之上（交响乐版）',
        path: 'music/moon-symphony.mp3',
        durationMs: 150_000,
        mood: '宏伟',
        tempo: '适中',
        topics: ['时政', '人文']
    },
    {
        id: 'track-eternity',
        name: 'eternity',
        path: 'music/eternity.mp3',
        durationMs: 192_000,
        mood: '抒情',
        tempo: '适中',
        topics: ['人文']
    }
];

export interface MusicSelectionInput {
    /** 来自 CreativeBrief 的情绪判断 */
    mood?: string;
    tempo?: string;
    topic?: string;
    /** 成片总时长，用于「够不够长」的加分 */
    totalMs: number;
    /** 换一首时排除已经否掉的 */
    exclude?: readonly string[];
    library?: readonly MusicTrackSpec[];
}

export interface MusicCandidate {
    track: MusicTrackSpec;
    score: number;
    reason: string;
}

export interface MusicSelection {
    track: MusicTrackSpec;
    reason: string;
    /** 落进 `ai.decisions` 的备选，供用户追溯「为什么是这首」 */
    alternatives: MusicCandidate[];
}

const SCORE_MOOD = 10;
const SCORE_TOPIC = 4;
const SCORE_TEMPO = 2;
/** 够长不用循环。这是硬加分：循环接缝是听得出来的 */
const SCORE_LONG_ENOUGH = 3;

function scoreTrack(
    track: MusicTrackSpec,
    input: MusicSelectionInput
): MusicCandidate {
    const hits: string[] = [];
    let score = 0;

    // 用 includes 而不是相等：brief 里可能写「平静、克制」这种带修饰的说法
    if (input.mood && input.mood.includes(track.mood)) {
        score += SCORE_MOOD;
        hits.push(`情绪「${track.mood}」契合`);
    }
    if (input.topic && track.topics.some((t) => input.topic!.includes(t))) {
        score += SCORE_TOPIC;
        hits.push(`题材偏向${track.topics.join('/')}`);
    }
    if (input.tempo && input.tempo.includes(track.tempo)) {
        score += SCORE_TEMPO;
        hits.push(`节奏「${track.tempo}」契合`);
    }
    if (track.durationMs >= input.totalMs) {
        score += SCORE_LONG_ENOUGH;
        hits.push('长度足够，无需循环');
    }

    return {
        track,
        score,
        reason: hits.length > 0 ? hits.join('；') : '无明显匹配，作为兜底候选'
    };
}

/**
 * 选一首。
 *
 * **确定性**：同分时按 id 字典序定序。不加这一条，`sort` 在不同引擎上的
 * 不稳定排序会让同一份输入选出不同的曲子。
 */
export function selectMusicTrack(input: MusicSelectionInput): MusicSelection {
    const library = input.library ?? BUILTIN_MUSIC_LIBRARY;
    const excluded = new Set(input.exclude ?? []);
    const pool = library.filter((track) => !excluded.has(track.id));

    if (pool.length === 0) {
        throw new Error('曲库为空（或候选已被全部排除），无法选曲');
    }

    const ranked = pool
        .map((track) => scoreTrack(track, input))
        .sort((a, b) =>
            b.score !== a.score
                ? b.score - a.score
                : a.track.id < b.track.id
                  ? -1
                  : 1
        );

    const best = ranked[0]!;
    return {
        track: best.track,
        reason: best.reason,
        alternatives: ranked.slice(1, 4)
    };
}

export interface MusicClipOptions {
    gainDb: number;
    fadeInMs: number;
    fadeOutMs: number;
    ducking: {
        enabled: boolean;
        targetDb: number;
        attackMs: number;
        releaseMs: number;
    };
}

export const DEFAULT_MUSIC_CLIP_OPTIONS: MusicClipOptions = {
    // -18dB：口播之下的垫底音量。再响就会压住人声
    gainDb: -18,
    fadeInMs: 800,
    fadeOutMs: 1500,
    ducking: {
        enabled: true,
        targetDb: -24,
        attackMs: 120,
        releaseMs: 400
    }
};

export interface MusicClipSpec {
    startMs: number;
    durationMs: number;
    gainDb: number;
    fade: { inMs: number; outMs: number };
    ducking: MusicClipOptions['ducking'];
    /** 源曲比成片短，渲染时需要循环。P1 只记录，P3 渲染才处理 */
    needsLoop: boolean;
    loopCount: number;
}

/**
 * 铺一条覆盖 `[0, totalMs]` 的音乐 clip——**不变量 6 的全部内容**。
 *
 * 淡入淡出会被夹到总时长的一半以内：短片配上 800+1500ms 的淡变，
 * 会出现「淡入还没完就开始淡出」的重叠。
 */
export function buildMusicClipSpec(
    track: MusicTrackSpec,
    totalMs: number,
    options: Partial<MusicClipOptions> = {}
): MusicClipSpec {
    if (totalMs <= 0) {
        throw new Error(`成片时长必须为正，收到 ${totalMs}`);
    }
    const merged = { ...DEFAULT_MUSIC_CLIP_OPTIONS, ...options };
    const half = Math.floor(totalMs / 2);

    return {
        startMs: 0,
        durationMs: totalMs,
        gainDb: merged.gainDb,
        fade: {
            inMs: Math.max(0, Math.min(merged.fadeInMs, half)),
            outMs: Math.max(0, Math.min(merged.fadeOutMs, half))
        },
        ducking: merged.ducking,
        needsLoop: track.durationMs < totalMs,
        loopCount: Math.max(1, Math.ceil(totalMs / track.durationMs))
    };
}
