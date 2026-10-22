import type { MediaIndexDb } from '@magicut-react-demo/media-index';

import type { ModelProvider } from '../llm/types';
import type { MusicTrackSpec } from '../music';
import type { SubtitleLayoutOptions } from '../subtitle';
import type { TtsProvider } from '../tts/types';

/**
 * 图运行时需要的全部外部依赖。
 *
 * **全部通过参数注入，不在节点里 new。** 这样整张图在没有凭证、没有网络的
 * 情况下也能跑（Mock provider + 内存库），而这正是 P1 全部验收的前提。
 */
export interface GraphDeps {
    db: MediaIndexDb;
    /**
     * 用户这次选中的素材（文件或目录的绝对路径）。
     *
     * **不传就是整库**——命令行那条路要的就是整库；桌面端必须传，
     * 否则会拿上次索引的别的目录给这条片子配画面。
     */
    mediaPaths?: readonly string[];
    model: ModelProvider;
    tts: TtsProvider;
    /** 音色。从配置读，不写死（plan.md §10） */
    voiceId: string;
    /** 工程落盘目录 */
    projectDir: string;
    /** 画布。P1 锁定横屏 1920×1080 30fps（plan.md §2） */
    canvas?: { width: number; height: number; fps: number };
    subtitle?: Partial<SubtitleLayoutOptions>;
    musicLibrary?: readonly MusicTrackSpec[];
    /** repair 最多试几轮。超限走第 4 级降级而不是死循环 */
    maxRepairAttempts?: number;
    /**
     * 成片时长与目标的容差比例。默认 ±12%。
     *
     * 卡得太死没有意义：配音时长是合成出来才知道的，改文案只能粗调，
     * 追求「正好 30.0 秒」会让它反复改写却永远差一点。
     */
    durationTolerance?: number;
    /** 按时长改写文案最多试几轮。每轮都要重跑 TTS，是要花钱的 */
    maxDurationAttempts?: number;
    /** 交给 LLM 精排的候选数上限 */
    topK?: number;
    onEvent?: (event: GraphEvent) => void;
}

/**
 * 图的可观测事件（plan.md §12）。
 *
 * **不含凭证、不含完整提示词**——事件会一路转发到渲染层。
 */
export type GraphEvent =
    | { type: 'node_start'; node: string }
    | { type: 'node_finish'; node: string }
    | {
          type: 'progress';
          node: string;
          done: number;
          total: number;
          label?: string;
      }
    | { type: 'decision'; node: string; summary: string }
    /**
     * 模型正在写。`text` 是**到目前为止已生成的人话**（不是增量，也不是原始 JSON）。
     *
     * 给的是累计值而不是增量：渲染层可能在中途才挂上监听（切页面、重连），
     * 只收增量的话它永远拼不出完整的一段。
     */
    | { type: 'partial'; node: string; text: string }
    /**
     * 文稿分析的结果。**准备阶段就摊开给用户看**，而不是攒到需求文档里。
     *
     * 分析错了（主题跑偏、把一句需求当成口播稿）要让人当场看出来——
     * 往后每一步都基于它，错得越晚越贵。
     */
    | {
          type: 'analysis';
          node: string;
          inputKind: string;
          /** 从原文读出来的段落结构 */
          outline: string[];
          theme: string;
          audience: string;
          tone: string;
          keyPoints: string[];
          /** 结合素材标签说的匹配情况 */
          materialFit: string;
      }
    /**
     * 成片需求文档：字段 + 说明的若干行。
     *
     * 这是**拼装出来的，不是模型编的**——每一行的值都来自前面几步的真实产出
     * （文稿分析的 brief、素材库画像、配置里的音色）。
     */
    | {
          type: 'requirements';
          node: string;
          rows: { field: string; detail: string }[];
      }
    | { type: 'awaiting_input'; node: string; payload: unknown }
    | { type: 'warning'; node: string; message: string }
    | { type: 'error'; node: string; message: string }
    | { type: 'finished'; savedPath: string };

export const DEFAULT_CANVAS = { width: 1920, height: 1080, fps: 30 } as const;
export const DEFAULT_MAX_REPAIR_ATTEMPTS = 3;
export const DEFAULT_DURATION_TOLERANCE = 0.12;
export const DEFAULT_MAX_DURATION_ATTEMPTS = 2;
