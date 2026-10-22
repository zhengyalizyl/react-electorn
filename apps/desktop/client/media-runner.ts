import { existsSync } from 'node:fs';
import path from 'node:path';

import type { IndexEvent } from '@magicut-react-demo/media-index';
import {
    MediaIndexDb,
    runIndexPipeline
} from '@magicut-react-demo/media-index';
import type { ModelProvider, TagEvent } from '@magicut-react-demo/video-agent';
import {
    ArkChatModelProvider,
    loadLlmConfig,
    MockModelProvider,
    runTaggingPipeline
} from '@magicut-react-demo/video-agent';

import type { MediaEvent, MediaFileSummary, MediaStatus } from './agent-ipc';

/**
 * 素材库的主进程侧：选素材、建索引、打标。
 *
 * ## 为什么索引与打标分成两个动作
 *
 * **索引是本地操作，打标要花钱。** 扫描 + ffprobe + 抽帧只用 CPU 和磁盘；
 * 打标每个片段要发几千 token 的多模态请求（plan.md §11）。
 * 合成一个按钮的话，用户选个目录就可能烧掉一笔钱，而他根本不知道。
 *
 * ## 事件同样要过净化
 *
 * 进度里**只给文件名不给完整路径**——同 §12，路径会暴露用户的目录结构。
 * （`MediaStatus.paths` 是例外：那是用户自己刚选的东西，不给他看就没法确认选对没有。）
 */

export interface MediaRunnerOptions {
    userDataDir: string;
    indexDbPath: string;
    keyframeDir: string;
    emit: (event: MediaEvent) => void;
    env?: Record<string, string | undefined>;
}

/**
 * 从整库的逐文件统计里，挑出落在选中路径下的那些。
 *
 * 选中项既可能是文件本身，也可能是目录。用前缀判断而不是 SQL 的 like：
 * 路径里完全可能出现 `%` 和 `_`，交给 SQL 还得处理转义。
 *
 * 前缀比较**必须带上分隔符**，否则选了 `/a/b` 会把 `/a/bc.mp4` 也算进来。
 */
export function selectedSummaries(
    all: readonly { path: string; segments: number; tagged: number }[],
    selected: readonly string[]
): MediaFileSummary[] {
    const covered = (filePath: string): boolean =>
        selected.some(
            (item) => filePath === item || filePath.startsWith(item + path.sep)
        );

    return all
        .filter((file) => covered(file.path))
        .map((file) => ({
            name: path.basename(file.path),
            segments: file.segments,
            tagged: file.tagged
        }));
}

export class MediaRunner {
    private readonly options: MediaRunnerOptions;
    /** 同一时刻只允许一个任务。两个索引同时写一个库只会互相打架 */
    private busy = false;
    /**
     * 这次选中的素材。**只活在这次运行里，不落盘。**
     *
     * 之前存进 settings.json，结果是：重开应用什么都没选，界面却报"1 个文件、1 个片段"。
     * 那个数字来自上次的选择，用户看着就是在撒谎。
     * 记住选择当然更方便，但要做就得在界面上说清"这是上次选的"，
     * 而不是伪装成这次的状态。
     */
    private selected: string[] = [];

    constructor(options: MediaRunnerOptions) {
        this.options = options;
    }

    private get paths(): string[] {
        return this.selected;
    }

    /** 记下用户选中的素材。文件、目录都行，扫描两种都认 */
    setPaths(paths: readonly string[]): MediaStatus {
        this.selected = [...paths];
        return this.status();
    }

    status(): MediaStatus {
        const db = MediaIndexDb.open(this.options.indexDbPath);
        try {
            return this.statusWith(db, this.busy);
        } finally {
            db.close();
        }
    }

    /**
     * 组装状态。
     *
     * 数字**只统计当前选中的那些文件**，不是整个索引库的合计：
     * 库里可能还留着上次索引的别的目录，拿合计去报这次的选择，数字就是错的。
     */
    private statusWith(db: MediaIndexDb, busy: boolean): MediaStatus {
        const paths = this.paths;
        const indexed = selectedSummaries(db.fileSummaries(), paths);

        return {
            paths,
            // 文件可能被删了、外置盘可能没挂上。界面要能说出"这几个不见了"，
            // 而不是只显示一串看着正常的路径
            missing: paths.filter((item) => !existsSync(item)),
            indexed,
            segments: indexed.reduce((sum, file) => sum + file.segments, 0),
            tagged: indexed.reduce((sum, file) => sum + file.tagged, 0),
            busy
        };
    }

    /** 扫描 + ffprobe + 抽帧。本地操作，不花钱 */
    async index(): Promise<MediaStatus> {
        const paths = this.paths;
        if (paths.length === 0) throw new Error('还没有选择素材');
        const usable = paths.filter((item) => existsSync(item));
        if (usable.length === 0) {
            throw new Error('选中的素材都不存在了，请重新选择');
        }
        return this.run('index', async (db) => {
            await runIndexPipeline({
                roots: usable,
                db,
                keyframeDir: this.options.keyframeDir,
                onEvent: (event) => this.onIndexEvent(event)
            });
        });
    }

    /** 关键帧打标。**要调模型，按量计费** */
    async tag(): Promise<MediaStatus> {
        const env = this.options.env ?? process.env;
        const config = loadLlmConfig(env);
        const provider: ModelProvider =
            config.provider === 'ark'
                ? new ArkChatModelProvider({ config })
                : new MockModelProvider({
                      responders: {
                          AssetTagger: {
                              description: '（未配置模型凭证，这是占位描述）',
                              tags: ['mock'],
                              subjectCenterX: 0.5,
                              subjectCenterY: 0.5,
                              orientation: 'landscape',
                              hasFaces: false
                          }
                      }
                  });

        if (config.provider !== 'ark') {
            this.options.emit({
                type: 'media_warning',
                job: 'tag',
                message:
                    '没有配置模型凭证，打标走的是占位描述。' +
                    '素材检索会几乎不可用——请在 .env 里配好 ARK_API_KEY'
            });
        }

        return this.run('tag', async (db) => {
            await runTaggingPipeline({
                db,
                provider,
                onEvent: (event) => this.onTagEvent(event)
            });
        });
    }

    private async run(
        job: 'index' | 'tag',
        body: (db: MediaIndexDb) => Promise<void>
    ): Promise<MediaStatus> {
        if (this.busy) throw new Error('已经有一个任务在跑了');
        this.busy = true;
        this.options.emit({ type: 'media_started', job });

        const db = MediaIndexDb.open(this.options.indexDbPath);
        try {
            await body(db);
            const status = this.statusWith(db, false);
            this.options.emit({ type: 'media_finished', job, status });
            return status;
        } catch (error) {
            const message =
                error instanceof Error ? error.message : String(error);
            this.options.emit({ type: 'media_failed', job, message });
            throw error;
        } finally {
            db.close();
            this.busy = false;
        }
    }

    private onIndexEvent(event: IndexEvent): void {
        const wire = toMediaEvent(event);
        if (wire) this.options.emit(wire);
    }

    private onTagEvent(event: TagEvent): void {
        const wire = tagToMediaEvent(event);
        if (wire) this.options.emit(wire);
    }
}

/**
 * 索引事件 → 渲染层事件。**这里是净化边界**（同 `toRunEvent`）。
 *
 * 只给文件名不给完整路径：路径会暴露用户的目录结构（plan.md §12）。
 * 单独抽出来是为了能直接测——挂在管线里的话，要跑一遍真 ffmpeg 才碰得到。
 */
export function toMediaEvent(event: IndexEvent): MediaEvent | null {
    if (event.type === 'file_started') {
        return {
            type: 'media_progress',
            job: 'index',
            done: event.done,
            total: event.total,
            label: path.basename(event.path)
        };
    }
    if (event.type === 'file_failed') {
        return {
            type: 'media_warning',
            job: 'index',
            message: `${path.basename(event.path)}：${event.message}`
        };
    }
    return null;
}

/** 打标事件 → 渲染层事件。片段 id 本身不含路径，照原样给 */
export function tagToMediaEvent(event: TagEvent): MediaEvent | null {
    if (event.type === 'segment_started') {
        return {
            type: 'media_progress',
            job: 'tag',
            done: event.done,
            total: event.total,
            label: event.segmentId
        };
    }
    if (event.type === 'segment_failed') {
        return {
            type: 'media_warning',
            job: 'tag',
            message: `${event.segmentId}：${event.message}`
        };
    }
    return null;
}
