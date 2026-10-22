/**
 * 媒资索引的公共类型。
 *
 * 约定同 video-project：**所有时间是毫秒整数**，字段名带 `Ms` 后缀。
 * 索引里的时长会直接变成时间线上的 clip 时长，这里出现浮点秒就等于给下游埋误差。
 */

/** 单个阶段的处理状态。失败也要落库，否则续跑时会无限重试同一个坏文件 */
export type StageState = 'pending' | 'ok' | 'failed';

/**
 * 素材的三大类。
 *
 * 下游对它们的处理路径根本不同——视频要抽帧、图片本身就是那一帧、音频没有画面，
 * 所以这不是个"顺带记一下"的标签，而是管线的分流依据。
 */
export type MediaKind = 'video' | 'audio' | 'image';

/** 扫描阶段能拿到的全部信息——只看 stat 与文件头，不解码 */
export interface ScannedFile {
    /** 绝对路径，索引内的唯一键 */
    path: string;
    sizeBytes: number;
    /** 取整到毫秒：SQLite 列是 integer，浮点存进去再读出来会不等 */
    mtimeMs: number;
    /**
     * 由扩展名初判、经魔数确认的大类。
     *
     * **是初判不是定论**：`.mp4` 与 `.m4a` 的文件头一模一样，靠头部分不出
     * 里面有没有视频流。探测之后 `ProbeResult.kind` 才是真的。
     */
    kind: MediaKind;
}

/**
 * ffprobe 探测结果。
 *
 * 三类素材共用一个形状，**不适用的字段为 null**——图片没有帧率，音频没有宽高。
 * 用 null 而不是 0：0 会悄悄通过 `minWidth` 之类的比较，null 不会。
 */
export interface ProbeResult {
    /** 按真实流构成判定，可能与扫描时的初判不同 */
    kind: MediaKind;
    /** 图片恒为 0——它没有时长，下游要显示多久由时间线决定 */
    durationMs: number;
    /** 纯音频为 null */
    width: number | null;
    height: number | null;
    /** 由 `r_frame_rate` 的有理数解析而来，可能是 29.97 这类非整数。音频与图片为 null */
    fps: number | null;
    /** 图片这里是 `mjpeg`/`png` 这类单帧编码。纯音频为 null */
    videoCodec: string | null;
    hasAudio: boolean;
    /** 音频流编码。无音频为 null */
    audioCodec: string | null;
    /**
     * 容器旋转角度，已归一到 0/90/180/270。
     *
     * 手机竖拍的素材往往是"横着存、靠元数据转 90°"。`width`/`height` 已按它
     * 交换过，这里保留原始角度是为了让渲染侧知道要不要跟着转——丢掉它，
     * 预览就会是倒的。
     */
    rotationDegrees: number;
    /** 比特率，优先取流级别，没有再退到容器级别。取不到为 null */
    bitRateBps: number | null;
}

/** 一张落盘的关键帧 */
export interface Keyframe {
    /** 在源片中的时刻 */
    atMs: number;
    /** 图片绝对路径 */
    path: string;
    /**
     * 这一帧的平均色，`#rrggbb`。取不到为 null。
     *
     * 给转场与滤镜做智能匹配用：两个相邻镜头的主色差多少，决定了该用硬切还是叠化。
     * 抽帧时顺手从同一次解码里取（缩到 1×1），不额外起进程。
     */
    avgColor: string | null;
}

/**
 * 可用片段：B4 打标、B5 检索、B9 取素材的**统一单位**。
 *
 * v1 里一个文件产出一段、覆盖整片。表名用复数是为了给「长片按场景切分成多段」
 * 留位置——那时候只需让 scan 产出多行，下游一行不用改。
 */
export interface AssetSegment {
    id: string;
    fileId: number;
    startMs: number;
    durationMs: number;
    tagState: StageState;
    /** 以下字段由 B4 填 */
    description: string | null;
    tags: string[];
    subjectX: number | null;
    subjectY: number | null;
    orientation: string | null;
    hasFaces: boolean | null;
}

/** 索引库里一个文件的完整状态 */
export interface MediaFileRecord extends ScannedFile {
    id: number;
    /** 探测成功后是探测出的真实类型，否则是扫描时的初判 */
    kind: MediaKind;
    probeState: StageState;
    probeError: string | null;
    keyframeState: StageState;
    keyframeError: string | null;
    probe: ProbeResult | null;
    /**
     * 200px 宽的缩略图路径。素材列表靠它出预览——直接拿原片当预览，
     * 一屏几十个 4K 文件能把渲染进程拖垮。纯音频没有画面，为 null。
     */
    thumbnailPath: string | null;
}

/** B5 检索的命中项。带上文件级字段，调用方不必再回查 */
export interface SearchHit {
    segmentId: string;
    fileId: number;
    path: string;
    kind: MediaKind;
    startMs: number;
    durationMs: number;
    description: string | null;
    tags: string[];
    width: number | null;
    height: number | null;
    hasAudio: boolean | null;
    /** BM25 分值。SQLite 的 bm25() **越小越相关**，已按升序返回 */
    score: number;
}

/** 检索的硬过滤条件（plan.md §8：先硬过滤，再 BM25 排序） */
export interface SearchFilters {
    /**
     * 只在这些文件里检索。传的是用户这次选中的素材（文件或目录）。
     *
     * **不传就是整库**——而整库里可能还留着上次索引的别的目录，
     * 拿它去给这次创作配素材，用户会看到自己根本没选的画面。
     */
    paths?: readonly string[];
    /**
     * 只要这几类素材。
     *
     * **不传就是全要**，包括音频——而音频片段同样带文件名进了 FTS，
     * 拿它去配画面就会得到一段没有画面的"镜头"。按画面检索时必须显式传
     * `['video', 'image']`。
     */
    kinds?: readonly MediaKind[];
    /** 片段至少要有这么长，否则装不下对应分镜的配音 */
    minDurationMs?: number;
    minWidth?: number;
    minHeight?: number;
    hasAudio?: boolean;
    /**
     * 只要**还没打过标**的片段（`tag_state != 'ok'`）。
     *
     * 这不是常规过滤条件，是**语义检索落空时的退路**：未打标的片段没有
     * `description`，FTS 里只剩文件名，而文件名经常是 `1e00bd49-….png`
     * 这种 UUID——任何查询词都匹配不上，素材明明在库里却等于不存在。
     *
     * 已打标却没匹配上的不在此列：那说明语义层尽职了，把它们塞回候选
     * 只会让模型从一堆无关画面里硬挑一个。
     */
    untaggedOnly?: boolean;
    limit?: number;
}

/**
 * 索引过程的可观测事件。
 *
 * 形状刻意与 plan.md §12 的 `AgentEvent` 对齐，B10 接 UI 时直接转发即可。
 * **事件里不允许出现凭证**——这一层本来就没有凭证，但规则要立在这里。
 */
export type IndexEvent =
    | {
          type: 'scan_started';
          roots: readonly string[];
          /** 上次扫描完成的时刻，首次为 null。界面上用来说"距上次扫描 3 天" */
          lastScanAt: number | null;
      }
    | {
          type: 'scan_finished';
          found: number;
          added: number;
          changed: number;
          pruned: number;
          /** 过了扩展名、但文件头对不上，被挡在索引外的数量 */
          rejected: number;
      }
    | { type: 'file_started'; path: string; done: number; total: number }
    | { type: 'file_skipped'; path: string; reason: 'unchanged' }
    /**
     * 魔数校验没过，这个文件压根没进索引。
     *
     * 一定要发出来：不发的话用户"挑了 5 个文件，扫出 3 个"而没有任何解释，
     * 比报一个错更难排查。
     */
    | { type: 'file_rejected'; path: string; reason: string }
    | {
          type: 'file_finished';
          path: string;
          durationMs: number;
          keyframes: number;
      }
    | {
          type: 'file_failed';
          path: string;
          stage: 'probe' | 'keyframes';
          message: string;
      }
    | { type: 'finished'; summary: IndexSummary };

/**
 * 素材库画像。创作前的「分析素材」用它，**不调模型**。
 */
export interface AssetOverview {
    files: number;
    segments: number;
    tagged: number;
    /** 所有文件的时长之和 */
    totalDurationMs: number;
    /** 出现最多的标签。片段里到底拍的是什么，靠它说话 */
    topTags: { tag: string; count: number }[];
}

/** 一次索引运行的结果统计 */
export interface IndexSummary {
    scanned: number;
    added: number;
    changed: number;
    skipped: number;
    /** 魔数校验没过、没进索引的文件数 */
    rejected: number;
    pruned: number;
    probed: number;
    keyframed: number;
    failed: number;
    /** 被 AbortSignal 中断时为 true——此时统计是部分的，但已处理的文件都已落库 */
    aborted: boolean;
}
