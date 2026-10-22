/**
 * 智能体的 IPC 契约（B10）。
 *
 * ## 为什么这里重新定义一套事件类型，而不是直接复用 `GraphEvent`
 *
 * 两个理由，都不是洁癖：
 *
 * 1. **这是一道净化边界。** plan.md §12 的硬约束是「事件里不允许出现凭证或
 *    完整提示词」。有一个显式的映射函数，这条约束才有地方落实、有地方测；
 *    直接把内部事件原样 `webContents.send` 出去，将来谁往 `GraphEvent` 上加个
 *    字段都可能顺手把敏感内容送进渲染层。
 * 2. **渲染层不该知道 video-agent 的存在。** 渲染层是浏览器环境，
 *    而 video-agent 拖着 langchain、sqlite、node:fs。哪怕只是类型引用，
 *    也会把那棵依赖树拉进渲染层的类型解析里。
 *
 * 所以这个文件**不 import 任何重依赖**，只有纯类型与常量。
 */

export const AGENT_CHANNELS = {
    /** 渲染层 → 主进程：开一次创作 */
    start: 'magicut:agent.start',
    /** 渲染层 → 主进程：在中断点给出答复 */
    approve: 'magicut:agent.approve',
    /**
     * 停在分镜确认时，按一句要求让模型改一版文案。
     *
     * **只算出新文案交回去，不替用户放行**——改成什么样他得先看见。
     */
    reviseScenes: 'magicut:agent.reviseScenes',
    /** 渲染层 → 主进程：取消 */
    cancel: 'magicut:agent.cancel',
    /** 渲染层 → 主进程：拉当前状态（重连或刷新后用） */
    state: 'magicut:agent.state',
    /** 主进程 → 渲染层：进度事件 */
    event: 'magicut:agent.event'
} as const;

export const PROJECT_CHANNELS = {
    /** 列出所有已保存的工程 */
    list: 'magicut:project.list',
    /** 读一个工程的完整内容 */
    load: 'magicut:project.load',
    /** 删除一个工程 */
    remove: 'magicut:project.remove',
    /** 给某一镜记一条修改要求 */
    request: 'magicut:project.request',
    /** 按一句要求把某一镜真的重做一遍：改文案、重念、重排 */
    refineScene: 'magicut:project.refineScene',
    /** 主进程 → 渲染层：改一镜的进度 */
    refineEvent: 'magicut:project.refineEvent',
    /** 改一条字幕样式（颜色、字号、描边） */
    subtitleStyle: 'magicut:project.subtitleStyle',
    /** 改配音轨的音量（dB） */
    voiceGain: 'magicut:project.voiceGain',
    /** 整份工程写回去。改结构（分割、删镜）只能这么存 */
    save: 'magicut:project.save',
    /** 渲染导出成 mp4 */
    export: 'magicut:project.export',
    /** 主进程 → 渲染层：渲染进度 */
    exportEvent: 'magicut:project.exportEvent'
} as const;

/**
 * 渲染进度。
 *
 * 总时长是已知的，所以 `ratio` 是**真进度**，不是一条假装在动的动画——
 * 渲染一条几分钟的片子要等很久，假进度条会让人以为卡死了。
 */
export interface ExportProgressEvent {
    ratio: number;
    renderedMs: number;
    totalMs: number;
}

/** 导出结果。用户在保存对话框里点了取消时是 `cancelled` */
export type ExportResult =
    | { status: 'done'; outPath: string }
    | { status: 'cancelled' };

/**
 * 改一镜走到哪一步了。
 *
 * **三档都要报出来**：先调模型想词（几秒）再合成（又几秒）。只转个圈的话，
 * 用户不知道是在想词还是在念，等上十几秒就会去点别的地方。
 *
 * 这里重新写一遍而不是从 `refine-scene.ts` 引：那个文件拖着 langchain，
 * 而本文件是渲染层也要读的净化边界。
 */
export type RefineStage = 'rewriting' | 'synthesizing' | 'relayout';

export const VOICE_CHANNELS = {
    /** 用某个音色合成一小段样本，供试听 */
    preview: 'magicut:voice.preview',
    /** 用某个音色把整条片子的口播重新合成一遍，并重排时间线 */
    regenerate: 'magicut:voice.regenerate',
    /** 主进程 → 渲染层：重新合成的进度 */
    event: 'magicut:voice.event',
    /** 自定义音色库：列出已传的人声样本 */
    sampleList: 'magicut:voice.sampleList',
    /** 开文件框挑一个人声样本收进库 */
    sampleAdd: 'magicut:voice.sampleAdd',
    /** 从库里删掉一个样本 */
    sampleRemove: 'magicut:voice.sampleRemove',
    /** 读出来试听 */
    sampleRead: 'magicut:voice.sampleRead',
    /** 本地复刻引擎现在能不能用 */
    sampleEngine: 'magicut:voice.sampleEngine'
} as const;

/**
 * 用户自己传进来的人声样本。
 *
 * 合成走本地 IndexTTS2，而它是**零样本**克隆——不训练、不注册，
 * 传完当场就能选来生成口播。所以这里没有"训练中"这一态：
 * 一条样本要么在库里（可用），要么不在。
 */
export interface VoiceSample {
    id: string;
    name: string;
    durationMs: number;
    sizeBytes: number;
    addedAt: string;
}

/**
 * 本地复刻引擎的状态。
 *
 * **"没配置"和"连不上"要补的东西完全不同**，所以 `reason` 是一句话而不是
 * 一个布尔：合成一个笼统的"不可用"，用户只能去猜是自己没装、没配，
 * 还是服务挂了。
 */
export interface VoiceEngineStatus {
    ready: boolean;
    /** 不可用的原因。可用时是 null */
    reason: string | null;
}

/**
 * 重新合成的进度。
 *
 * 九个分镜要逐个合成，**不是瞬间的事**。只有"在转圈/没在转圈"的话，
 * 用户不知道是快好了还是卡住了，等上一分钟就会去点取消或者关窗口。
 */
export interface VoiceRegenerateEvent {
    done: number;
    total: number;
    /** 当前这一镜的文案开头。**只给开头**，整段文案没必要过 IPC */
    label: string;
}

/** 试听返回的那一小段音频。渲染层拿不到本地路径，所以直接给它字节 */
export interface VoicePreview {
    /** `data:audio/mpeg;base64,…`，可以直接喂给 <audio> */
    dataUrl: string;
    durationMs: number;
    /** 哪个 provider 合成的。mock 产出的是**静音**，界面要说清楚 */
    provider: string;
}

export const MEDIA_CHANNELS = {
    /** 打开系统文件选择框，挑视频文件（也可以挑整个目录） */
    pick: 'magicut:media.pick',
    /** 当前选中的素材与索引状态 */
    status: 'magicut:media.status',
    /** 清空这次的选择 */
    clear: 'magicut:media.clear',
    /** 扫描 + ffprobe + 抽帧。本地操作，不花钱 */
    index: 'magicut:media.index',
    /** 关键帧打标。**要调模型，按量计费** */
    tag: 'magicut:media.tag',
    /** 主进程 → 渲染层：索引/打标进度 */
    event: 'magicut:media.event'
} as const;

// ── 素材库 ───────────────────────────────────────────────────────────────

export interface MediaFileSummary {
    /** 文件名。**不给完整路径**——路径会暴露用户的目录结构（§12） */
    name: string;
    segments: number;
    tagged: number;
}

export interface MediaStatus {
    /**
     * 用户选中的素材：视频文件的绝对路径，也可以是整个目录。
     *
     * 是数组而不是单个目录，因为用户是在系统对话框里**多选 .mp4** 的——
     * 素材未必整齐地躺在同一个文件夹里。
     */
    paths: string[];
    /** 其中已经不存在的那些。盘没挂上、文件被删时界面要能说出来 */
    missing: string[];
    /**
     * **选中范围内**已经进了索引库的文件，逐个带上段数。
     *
     * 不是整个库的合计：库里可能还留着上次索引的别的目录，
     * 拿合计去说当前这次选择，数字就是错的。
     */
    indexed: MediaFileSummary[];
    /** 选中范围内的片段总数 */
    segments: number;
    /** 选中范围内已打标的片段数 */
    tagged: number;
    /** 有没有正在跑的索引/打标任务 */
    busy: boolean;
}

export type MediaEvent =
    | { type: 'media_started'; job: 'index' | 'tag' }
    | {
          type: 'media_progress';
          job: 'index' | 'tag';
          done: number;
          total: number;
          /** 当前处理的文件名。**只给文件名不给完整路径** */
          label: string;
      }
    | { type: 'media_warning'; job: 'index' | 'tag'; message: string }
    | { type: 'media_finished'; job: 'index' | 'tag'; status: MediaStatus }
    | { type: 'media_failed'; job: 'index' | 'tag'; message: string };

// ── 工程列表 ─────────────────────────────────────────────────────────────

/**
 * 工程摘要。
 *
 * **只带列表要用的字段**，不把整个 VideoProject 塞过来——
 * 一个工程的 JSON 可能有几百 KB，列表页要十几个的话就是几 MB 过 IPC。
 */
export interface ProjectSummary {
    id: string;
    title: string;
    /** ISO 时间串，格式化交给渲染层 */
    createdAt: string;
    updatedAt: string;
    durationMs: number;
    sceneCount: number;
    /** 工程目录名。打开与删除按它定位，比完整路径安全 */
    dirName: string;
}

// ── 事件 ─────────────────────────────────────────────────────────────────

/** 需要用户确认的两个中断点 */
export type ApprovalNode = 'SceneApproval' | 'MatchApproval';

export interface ScenePreview {
    goal: string;
    script: string;
    visualIntent: string;
}

export interface MatchPreview {
    goal: string;
    segmentId: string | null;
    /** **只给文件名，不给完整路径**——路径会暴露用户的目录结构 */
    assetName: string | null;
    abandoned: boolean;
}

export type AgentRunEvent =
    | { type: 'node_start'; runId: string; node: string }
    | { type: 'node_finish'; runId: string; node: string }
    | {
          type: 'progress';
          runId: string;
          node: string;
          done: number;
          total: number;
          label?: string;
      }
    | { type: 'decision'; runId: string; node: string; summary: string }
    /**
     * 模型正在写。`text` 是**到目前为止已生成的人话**（累计值，不是增量）。
     *
     * 给累计值是因为渲染层可能中途才挂上监听（切页面、重连），
     * 只收增量的话它永远拼不出完整的一段。
     */
    | { type: 'partial'; runId: string; node: string; text: string }
    /**
     * 文稿分析结果。准备阶段就摊开给用户看——
     * 分析错了要当场看出来，往后每一步都基于它。
     */
    | {
          type: 'analysis';
          runId: string;
          inputKind: string;
          outline: string[];
          theme: string;
          audience: string;
          tone: string;
          keyPoints: string[];
          materialFit: string;
      }
    /** 成片需求文档：字段 + 说明。值全部来自前面几步的真实产出 */
    | {
          type: 'requirements';
          runId: string;
          rows: { field: string; detail: string }[];
      }
    /** 需求文档等你点头。往后每一步都花钱，这里是最后一次便宜的回头机会 */
    | {
          type: 'awaiting_requirements';
          runId: string;
          rows: { field: string; detail: string }[];
      }
    | {
          type: 'awaiting_scenes';
          runId: string;
          scenes: ScenePreview[];
      }
    | {
          type: 'awaiting_matches';
          runId: string;
          matches: MatchPreview[];
      }
    | { type: 'warning'; runId: string; node: string; message: string }
    | { type: 'error'; runId: string; message: string }
    | { type: 'finished'; runId: string; savedPath: string }
    | { type: 'cancelled'; runId: string };

// ── 请求与响应 ───────────────────────────────────────────────────────────

export interface StartRunInput {
    prompt: string;
    /**
     * 界面选中的音色 id。
     *
     * 可选：**渲染层给的值不可信**，主进程要对着音色目录白名单校验，
     * 不认识就退回 `TTS_VOICE` / 默认音色，而不是把它原样发给合成服务。
     */
    voiceId?: string;
}

export interface StartRunResult {
    runId: string;
}

export type ApprovalAnswer =
    /** 需求文档只有放行一个动作：要改得回去改提示词 */
    | { node: 'RequirementApproval'; action: 'approve' }
    | { node: 'SceneApproval'; action: 'approve' }
    | { node: 'SceneApproval'; action: 'modify'; scripts: string[] }
    | { node: 'MatchApproval'; action: 'approve' }
    | { node: 'MatchApproval'; action: 'reject'; rejectedIndexes: number[] };

export type RunStatus =
    | 'running'
    | 'awaiting_requirements'
    | 'awaiting_scenes'
    | 'awaiting_matches'
    | 'finished'
    | 'failed'
    | 'cancelled';

export interface RunSnapshot {
    runId: string;
    status: RunStatus;
    /** 当前所在节点，供界面显示"正在做什么" */
    node: string | null;
    savedPath: string | null;
    error: string | null;
}
