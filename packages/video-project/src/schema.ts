import { z } from 'zod';

/**
 * VideoProject 工程文件的 Zod schema。
 *
 * 约定见 docs/video-agent/plan.md §7：
 * - 所有时间是毫秒整数，字段名带 Ms 后缀。不用浮点秒，累积误差会让轨道错位。
 * - 所有引用用 branded id，避免 id 与路径、或不同种类的 id 之间互相串用。
 * - clip 与 track 都用判别联合，「视频轨里混进字幕 clip」这类错配由 schema 直接拦下，
 *   不必等到语义校验。
 */

/** 当前工程格式版本。结构不兼容变更时 +1，并在 io.ts 补一条迁移 */
/**
 * 3：视频片段带上了画面效果（抠图换背景、人像美颜）。
 *
 * 这一版的字段**全都有默认值**，旧工程不迁移也解析得动。那为什么还要 +1？
 *
 * 因为 zod 的对象解析会**悄悄丢掉不认识的键**。不升版的话，拿旧版应用打开一份
 * 新工程，`effects` 会被原样剥掉，再存一次就真的没了——用户调好的抠图背景
 * 和美颜参数凭空消失，而中间没有任何一处说过话。
 *
 * 升到 3 之后旧版应用会在 `migrate` 里直接拒绝打开，并说「请升级应用」。
 * **说不出口比说错更糟**：打不开是明确的，默默改坏数据不是。
 *
 * 2：配音片段带上了源内区间（`inMs`/`outMs`）。
 *
 * 加它是为了**分割**：把一镜切成两镜时，两半要各播同一个音频文件的一段。
 * 在此之前配音只有 `startMs/durationMs`，「只播这个文件的后半截」这件事
 * 格式根本表达不出来——于是分割只能靠 ffmpeg 真去切文件，
 * 那会产出需要回收的新文件，撤销时也收不回来。
 *
 * 视频片段本来就是这么做的，这一版只是把配音拉齐。
 */
export const CURRENT_SCHEMA_VERSION = 3;

// ── branded id ───────────────────────────────────────────────────────────
// 用 brand 而不是裸 string：把 assetId 传进要 sceneId 的位置会编译不过。

// brand 名走类型参数而不是运行时形参：省掉一个永远用不到的实参
const brandedId = <B extends string>() => z.string().min(1).brand<B>();

export const projectIdSchema = brandedId<'ProjectId'>();
export const sceneIdSchema = brandedId<'SceneId'>();
export const assetIdSchema = brandedId<'AssetId'>();
export const clipIdSchema = brandedId<'ClipId'>();
export const trackIdSchema = brandedId<'TrackId'>();
export const styleIdSchema = brandedId<'StyleId'>();

export type ProjectId = z.infer<typeof projectIdSchema>;
export type SceneId = z.infer<typeof sceneIdSchema>;
export type AssetId = z.infer<typeof assetIdSchema>;
export type ClipId = z.infer<typeof clipIdSchema>;
export type TrackId = z.infer<typeof trackIdSchema>;
export type StyleId = z.infer<typeof styleIdSchema>;

// ── 基础标量 ─────────────────────────────────────────────────────────────

/** 毫秒时刻：非负整数 */
const timeMs = z.int().nonnegative();

/** 毫秒时长：正整数。零长 clip 没有意义，直接在 schema 层拒掉 */
const durationMs = z.int().positive();

/** 归一化坐标，用于裁切锚点 */
const unitInterval = z.number().min(0).max(1);

// ── 资源 ─────────────────────────────────────────────────────────────────

export const assetKindSchema = z.enum(['video', 'audio', 'music']);

export const assetSchema = z.object({
    kind: assetKindSchema,
    /** 相对项目目录，保证工程可整体拷走 */
    path: z.string().min(1),
    /** 引用外部素材库时才有值；跨机迁移靠 hash 重新定位 */
    absolutePath: z.string().min(1).nullable().default(null),
    hash: z.string().min(1),
    durationMs,
    width: z.int().positive().optional(),
    height: z.int().positive().optional(),
    fps: z.number().positive().optional()
});

// ── 分镜 ─────────────────────────────────────────────────────────────────

export const sceneSchema = z.object({
    id: sceneIdSchema,
    index: z.int().nonnegative(),
    /** 这一镜要达成什么 */
    goal: z.string(),
    /** 配音文案 */
    script: z.string(),
    /** 增量失效的依据：文案没变就不重新合成配音 */
    scriptHash: z.string().min(1),
    /** 画面意图，供素材检索使用 */
    visualIntent: z.string(),
    startMs: timeMs,
    durationMs,
    refs: z.object({
        /**
         * **一个分镜对应一个视频片段。**
         * 一镜之内换画面就不是同一镜了——那是两镜。
         */
        video: clipIdSchema,
        /**
         * 配音可以有多段。
         *
         * 一段话中间要停顿、要换气、要分句合成，都会落成多条；
         * 写成单条的话，这些需求只能靠"把整段重合成一次"硬撑。
         *
         * **顺序即播放顺序**，拼起来必须等于 `script`（见 validate 的不变量）。
         */
        voice: z.array(clipIdSchema).min(1),
        subtitle: z.array(clipIdSchema)
    }),
    aiNotes: z.string().optional()
});

// ── 画面效果 ─────────────────────────────────────────────────────────────
//
// 抠图换背景与人像美颜挂在**视频片段**上，不挂在分镜上：一镜对一个片段
// （见 `sceneSchema.refs.video` 的注释），而效果作用的对象是画面本身。
// 挂在分镜上的话，分割之后两半要各自指回同一份效果，多一层间接却没有任何收益。

/** `#RRGGBB`。不收 CSS 颜色名：ffmpeg 与 WebGL 认的颜色写法不是同一套 */
const hexColor = z.string().regex(/^#[0-9a-fA-F]{6}$/);

/** 滑杆位置，0–100。**存位置不存物理量**，见 effects.ts 开头的说明 */
const sliderValue = z.number().min(0).max(100);

/**
 * 抠完之后背后放什么。
 *
 * `blur` 是默认：它**不需要任何额外素材**，而人像视频里"背景虚化"也恰好是
 * 最常被要的那一档。纯色次之。图片那档要先有文件，所以不能当默认。
 */
export const backgroundSchema = z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('color'), color: hexColor }),
    z.object({
        kind: z.literal('gradient'),
        from: hexColor,
        to: hexColor
    }),
    /** 保留原背景，只把它糊掉。`strength` 是滑杆位置，换算见 effects.ts */
    z.object({ kind: z.literal('blur'), strength: sliderValue }),
    z.object({
        kind: z.literal('image'),
        /**
         * **相对工程目录**，和 `asset.path` 同一条规矩：工程要能整体拷走。
         *
         * 不进 `assets` 表是因为那张表的每一项都要求 `durationMs` 为正整数，
         * 而一张背景图没有时长。硬塞一个假时长进去，校验那九条不变量时
         * 就得到处为它开口子。
         */
        path: z.string().min(1),
        /** 这张图哪来的。AI 生成的要能看出来，也便于重新生成 */
        source: z.enum(['local', 'generated']).default('local'),
        /** 生成时用的那句描述。本地选的图没有这一项 */
        prompt: z.string().optional()
    })
]);

export const DEFAULT_BACKGROUND = {
    kind: 'blur',
    strength: 60
} as const satisfies z.input<typeof backgroundSchema>;

export const mattingSchema = z.object({
    enabled: z.boolean().default(false),
    /**
     * 分割模型给的是**概率**，不是非黑即白的蒙版。这个值决定多大概率算前景。
     *
     * 调高会咬掉头发边缘，调低会把背景的一圈粘过来——没有一个值对所有素材都对，
     * 所以它是个旋钮而不是常量。
     */
    threshold: z.number().min(0).max(1).default(0.5),
    /**
     * 蒙版边缘的羽化半径（画布像素）。
     *
     * 不羽化的话人像边缘是**硬的锯齿**，叠在干净背景上一眼就能看出是抠出来的。
     */
    featherPx: z.number().min(0).max(24).default(3),
    background: backgroundSchema.default(DEFAULT_BACKGROUND)
});

/**
 * 人像美颜。四档都是 0–100 的滑杆位置。
 *
 * `skinOnly` 决定磨皮与美白是否只作用在皮肤区域。关掉它整帧一起处理——
 * 那会把背景里的纹理也一起糊掉，**看上去像是镜头脏了**。
 * 开着它要多跑一张皮肤蒙版，代价是分割模型的输出多用一个通道。
 */
export const beautySchema = z.object({
    enabled: z.boolean().default(false),
    /** 磨皮 */
    smooth: sliderValue.default(0),
    /** 美白 */
    whiten: sliderValue.default(0),
    /** 红润 */
    rosy: sliderValue.default(0),
    /** 锐化 */
    sharpen: sliderValue.default(0),
    skinOnly: z.boolean().default(true)
});

/**
 * ⚠️ 这里必须是 `prefault` 不是 `default`。
 *
 * zod 的 `.default(v)` **直接返回 v，不再过一遍 schema**——写成 `.default({})`
 * 的话，缺这一段的旧工程拿到的是字面量 `{}`，里面一个字段都没有。
 * 于是 `matting.enabled` 是 `undefined` 而不是 `false`，所有
 * `if (!matting.enabled)` 看着还对，`effects.beauty.smooth` 却会算出 NaN。
 *
 * `prefault` 把默认值**送进 schema 再解析**，内层那些 `.default()` 才会展开。
 */
export const clipEffectsSchema = z.object({
    matting: mattingSchema.prefault({}),
    beauty: beautySchema.prefault({})
});

// ── clip 判别联合 ────────────────────────────────────────────────────────

const clipBase = {
    id: clipIdSchema,
    startMs: timeMs,
    durationMs
};

export const videoClipSchema = z.object({
    ...clipBase,
    kind: z.literal('video'),
    sceneId: sceneIdSchema,
    assetId: assetIdSchema,
    /** 源内裁切区间。不做变速，所以 outMs - inMs 必须等于 durationMs */
    inMs: timeMs,
    outMs: timeMs,
    /** 素材比例与画布不符时的裁切锚点，来自索引期的主体位置分析 */
    crop: z
        .object({ anchorX: unitInterval, anchorY: unitInterval })
        .default({ anchorX: 0.5, anchorY: 0.5 }),
    transform: z
        .object({
            scale: z.number().positive(),
            x: z.number(),
            y: z.number()
        })
        .default({ scale: 1, x: 0, y: 0 }),
    transitions: z
        .object({
            in: z.enum(['none', 'fade', 'cut']),
            out: z.enum(['none', 'fade', 'cut'])
        })
        .default({ in: 'none', out: 'cut' }),
    /**
     * 素材自带的声音要不要留。
     *
     * **默认静音**：这是口播片，素材原声会和旁白抢。实跑里第一段素材自带人声，
     * 播到 5 秒切到第二段（无声）时，背景音突然消失——听上去就是"没接好"。
     *
     * 需要原声的场景（现场同期声、采访）把它设成 false，并自己调 `sourceGainDb`。
     */
    muteSource: z.boolean().default(true),
    /** 保留原声时的增益。静音时这个值没有意义 */
    sourceGainDb: z.number().default(-12),
    /**
     * 素材比这一镜短时，**定格在最后一帧**撑完剩下的时间。
     *
     * 分镜长度由配音决定，素材凑不够那么久是常态（用户要 20 秒、手上只有
     * 9 秒画面时每一镜都这样）。没有这个字段的话只有两条路：
     * 要么硬把 `outMs` 写到素材长度之外（工程非法），
     * 要么这一镜干脆没有画面（比定格差得多）。
     *
     * 它同时是**校验的开关**：置位时允许 `outMs - inMs < durationMs`，
     * 不置位时仍然要求两者严格相等（不做变速）。
     * 所以"定格"是一个需要显式声明的决定，不是算漏了时长的兜底。
     */
    holdLastFrame: z.boolean().default(false),
    /**
     * 画面效果：抠图换背景、人像美颜。
     *
     * 两样都默认关着，所以**没碰过这个开关的片子渲染路径一个字都没变**——
     * 效果链只在开启时才拼进 filter_complex（见 render-plan.ts）。
     *
     * 同样走 `prefault`：理由见 `clipEffectsSchema` 上面那段。
     */
    effects: clipEffectsSchema.prefault({})
});

export const voiceClipSchema = z.object({
    ...clipBase,
    kind: z.literal('voice'),
    sceneId: sceneIdSchema,
    assetId: assetIdSchema,
    /**
     * 源内裁切区间。和视频片段同一套含义：**不做变速**，
     * 所以 `outMs - inMs` 必须等于 `durationMs`。
     *
     * 整段配音时就是 `0 .. durationMs`；分割之后两半各占一段。
     */
    inMs: timeMs,
    outMs: timeMs,
    /**
     * **送进 TTS 的就是这串字。**
     *
     * 不落盘的话，"文稿字幕里显示的"和"真的拿去合成的"就没有任何东西保证一致——
     * 改了文稿忘了重合成、或者合成时做了点加工，界面上都看不出来。
     * 有了它，validate 才能把这件事钉成不变量。
     */
    text: z.string().min(1),
    gainDb: z.number().default(0),
    /** 合成来源，便于追溯与复现 */
    provider: z.object({
        name: z.string().min(1),
        model: z.string().min(1),
        voiceId: z.string().min(1)
    })
});

export const subtitleClipSchema = z.object({
    ...clipBase,
    kind: z.literal('subtitle'),
    sceneId: sceneIdSchema,
    text: z.string().min(1),
    styleRef: styleIdSchema
});

export const musicClipSchema = z.object({
    ...clipBase,
    kind: z.literal('music'),
    assetId: assetIdSchema,
    gainDb: z.number().default(-18),
    fade: z
        .object({ inMs: timeMs, outMs: timeMs })
        .default({ inMs: 0, outMs: 0 }),
    ducking: z
        .object({
            enabled: z.boolean(),
            targetDb: z.number(),
            attackMs: timeMs,
            releaseMs: timeMs
        })
        .default({
            enabled: true,
            targetDb: -24,
            attackMs: 120,
            releaseMs: 400
        })
});

export const clipSchema = z.discriminatedUnion('kind', [
    videoClipSchema,
    voiceClipSchema,
    subtitleClipSchema,
    musicClipSchema
]);

// ── track 判别联合 ───────────────────────────────────────────────────────
// 每类轨道只收对应类型的 clip，错配在 schema 层就报错。

export const videoTrackSchema = z.object({
    id: trackIdSchema,
    kind: z.literal('video'),
    clips: z.array(videoClipSchema)
});

export const voiceTrackSchema = z.object({
    id: trackIdSchema,
    kind: z.literal('voice'),
    clips: z.array(voiceClipSchema)
});

export const subtitleTrackSchema = z.object({
    id: trackIdSchema,
    kind: z.literal('subtitle'),
    clips: z.array(subtitleClipSchema)
});

export const musicTrackSchema = z.object({
    id: trackIdSchema,
    kind: z.literal('music'),
    clips: z.array(musicClipSchema)
});

export const trackSchema = z.discriminatedUnion('kind', [
    videoTrackSchema,
    voiceTrackSchema,
    subtitleTrackSchema,
    musicTrackSchema
]);

// ── 其余区块 ─────────────────────────────────────────────────────────────

export const canvasSchema = z.object({
    width: z.int().positive(),
    height: z.int().positive(),
    fps: z.number().positive(),
    durationMs,
    safeArea: z
        .object({
            top: z.int().nonnegative(),
            bottom: z.int().nonnegative(),
            left: z.int().nonnegative(),
            right: z.int().nonnegative()
        })
        .partial()
        .default({})
});

export const subtitleStyleSchema = z.object({
    fontFamily: z.string().min(1),
    fontSize: z.number().positive(),
    fontWeight: z.number().int().positive(),
    color: z.string().min(1),
    stroke: z
        .object({ color: z.string().min(1), width: z.number().nonnegative() })
        .optional(),
    align: z.enum(['left', 'center', 'right']).default('center')
});

/** P3 渲染参数占位。P1 只写默认值，不消费 */
export const renderSchema = z.object({
    container: z.enum(['mp4', 'mov']).default('mp4'),
    videoCodec: z.enum(['h264', 'hevc']).default('h264'),
    audioCodec: z.enum(['aac']).default('aac'),
    bitrateKbps: z.int().positive().default(8000),
    preset: z.string().default('medium')
});

export const aiDecisionSchema = z.object({
    sceneId: sceneIdSchema.optional(),
    node: z.string().min(1),
    chosen: z.string().min(1),
    reason: z.string(),
    alternatives: z
        .array(
            z.object({
                assetId: assetIdSchema,
                score: z.number(),
                rejected: z.string()
            })
        )
        .default([])
});

export const aiApprovalSchema = z.object({
    node: z.string().min(1),
    at: z.iso.datetime({ offset: true }),
    action: z.enum(['approved', 'modified', 'rejected']),
    changedScenes: z.array(sceneIdSchema).default([])
});

export const aiFailureSchema = z.object({
    sceneId: sceneIdSchema.optional(),
    node: z.string().min(1),
    reason: z.string().min(1),
    attempts: z.int().nonnegative(),
    resolution: z.string()
});

/**
 * 创作过程的一条留痕：某一步**用人话说清楚它做了什么**。
 *
 * 与 `decisions` 的分工：`decisions` 回答"这一镜为什么选了这个素材"（逐镜、结构化），
 * `notes` 回答"分析文稿时它是怎么理解的、方案为什么这么定"（逐步、成段）。
 *
 * 落在工程里而不是只停在聊天页：编辑器是**之后**打开的，
 * 那时用户最想知道的正是"它当时怎么想的"。
 */
export const aiNoteSchema = z.object({
    /** 哪一步产出的，例如 CreativeBrief */
    node: z.string().min(1),
    /** 说人话的那段。**不含隐藏推理链**，只有可公开的理解与打算 */
    text: z.string().min(1)
});

/**
 * 用户对某一镜提的要求。
 *
 * 编辑器里「快捷调整」输入的内容**落进工程**，而不是只停在输入框里：
 * 说过的话关掉窗口就没了，等于没说。
 *
 * ⚠️ 记下**不等于已经改了片子**——P1 还没有"对着某一镜重做"的能力。
 * 所以界面上要说清楚这是"记下来的要求"，别让人以为视频已经变了。
 */
export const aiRequestSchema = z.object({
    /** 针对哪一镜。整片级别的要求填 null */
    sceneId: sceneIdSchema.nullable(),
    text: z.string().min(1),
    createdAt: z.iso.datetime({ offset: true })
});

export const aiSchema = z.object({
    runId: z.string().min(1),
    graphVersion: z.string().min(1),
    approvals: z.array(aiApprovalSchema).default([]),
    decisions: z.array(aiDecisionSchema).default([]),
    failures: z.array(aiFailureSchema).default([]),
    /** 创作过程留痕。老工程没有这一段，所以给默认值 */
    notes: z.array(aiNoteSchema).default([]),
    /** 用户提的修改要求。同样给默认值，老工程读得回来 */
    requests: z.array(aiRequestSchema).default([])
});

// ── 顶层 ─────────────────────────────────────────────────────────────────

export const videoProjectSchema = z.object({
    schemaVersion: z.int().positive(),
    project: z.object({
        id: projectIdSchema,
        title: z.string(),
        sourcePrompt: z.string(),
        createdAt: z.iso.datetime({ offset: true }),
        updatedAt: z.iso.datetime({ offset: true })
    }),
    canvas: canvasSchema,
    assets: z.record(assetIdSchema, assetSchema),
    scenes: z.array(sceneSchema),
    tracks: z.array(trackSchema),
    styles: z.record(styleIdSchema, subtitleStyleSchema),
    render: renderSchema,
    ai: aiSchema
});

// ── 导出类型 ─────────────────────────────────────────────────────────────

export type Asset = z.infer<typeof assetSchema>;
export type Scene = z.infer<typeof sceneSchema>;
export type VideoClip = z.infer<typeof videoClipSchema>;
export type VoiceClip = z.infer<typeof voiceClipSchema>;
export type SubtitleClip = z.infer<typeof subtitleClipSchema>;
export type MusicClip = z.infer<typeof musicClipSchema>;
export type Clip = z.infer<typeof clipSchema>;
export type Track = z.infer<typeof trackSchema>;
export type Canvas = z.infer<typeof canvasSchema>;
export type Background = z.infer<typeof backgroundSchema>;
export type Matting = z.infer<typeof mattingSchema>;
export type Beauty = z.infer<typeof beautySchema>;
export type ClipEffects = z.infer<typeof clipEffectsSchema>;
export type SubtitleStyle = z.infer<typeof subtitleStyleSchema>;
export type AiDecision = z.infer<typeof aiDecisionSchema>;
export type AiNote = z.infer<typeof aiNoteSchema>;
export type AiRequest = z.infer<typeof aiRequestSchema>;
export type VideoProject = z.infer<typeof videoProjectSchema>;
