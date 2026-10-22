import { useCallback, useEffect, useState } from 'react';

import type { MediaEvent, MediaStatus } from '@/client/agent-ipc';
import { mediaBridge } from '@/renderer/data/bridge';

/**
 * 素材库状态（选素材、建索引、打标）。
 *
 * ## 选完自动建索引，但**绝不碰打标**
 *
 * 索引是本地操作（扫描 + ffprobe + 抽帧），只花 CPU 和磁盘；用户刚刚亲手挑完文件，
 * 再让他点一次"建立索引"纯属多余。
 *
 * 打标不一样：每个片段都要发多模态请求，**是要花钱的**。界面上已按用户要求
 * 去掉了那个按钮，这里也就不暴露 `tag`——没有入口，就更不该自动跑。
 * 需要打标走命令行：`pnpm --filter @magicut-react-demo/video-agent tag`。
 *
 * ## 选择的有效期是"一次创作"
 *
 * `resetOnMount` 让创作页每次进来都从"什么都没选"开始。
 * 主进程那头是按应用进程记的，不清的话：从项目页切回创作页，
 * 旁边还挂着上一条片子选的素材——那不是这次的状态。
 */

export interface MediaProgress {
    job: 'index' | 'tag';
    done: number;
    total: number;
    label: string;
}

export interface UseMediaLibrary {
    /** 桥不存在（浏览器里跑）时为 false */
    available: boolean;
    status: MediaStatus | null;
    progress: MediaProgress | null;
    warnings: string[];
    error: string | null;
    /** 打开系统文件选择框挑视频，**挑完直接建索引** */
    pickAndIndex: () => Promise<void>;
    /** 清空选择。选错了要能一键回到"什么都没选" */
    clear: () => Promise<void>;
}

const EMPTY: MediaStatus = {
    paths: [],
    missing: [],
    indexed: [],
    segments: 0,
    tagged: 0,
    busy: false
};

export interface UseMediaLibraryOptions {
    /** 挂载时清空上一次的选择。创作页用它，进行页不用（它要显示这次用了什么） */
    resetOnMount?: boolean;
}

export function useMediaLibrary(
    options: UseMediaLibraryOptions = {}
): UseMediaLibrary {
    const resetOnMount = options.resetOnMount ?? false;
    const [status, setStatus] = useState<MediaStatus | null>(null);
    const [progress, setProgress] = useState<MediaProgress | null>(null);
    const [warnings, setWarnings] = useState<string[]>([]);
    const [error, setError] = useState<string | null>(null);

    useEffect(() => {
        const bridge = mediaBridge();
        if (!bridge) return;

        // 创作页每次进来都从头开始：上一条片子选的素材不是这次的状态
        void (resetOnMount ? bridge.clear() : bridge.status()).then(setStatus);

        // **必须退订**，理由同 §12.3：不退的话切几次页面监听器就重复了
        return bridge.onEvent((event: MediaEvent) => {
            switch (event.type) {
                case 'media_started':
                    setError(null);
                    setWarnings([]);
                    setStatus((prev) => ({ ...(prev ?? EMPTY), busy: true }));
                    break;
                case 'media_progress':
                    setProgress({
                        job: event.job,
                        done: event.done,
                        total: event.total,
                        label: event.label
                    });
                    break;
                case 'media_warning':
                    // 只留最近几条：一个坏目录可能刷出几百条，
                    // 全堆在界面上等于什么都没说
                    setWarnings((prev) => [...prev.slice(-4), event.message]);
                    break;
                case 'media_finished':
                    setStatus(event.status);
                    setProgress(null);
                    break;
                case 'media_failed':
                    setError(event.message);
                    setProgress(null);
                    setStatus((prev) => ({ ...(prev ?? EMPTY), busy: false }));
                    break;
                default:
                    break;
            }
        });
    }, [resetOnMount]);

    const pickAndIndex = useCallback(async () => {
        const bridge = mediaBridge();
        if (!bridge) return;
        setError(null);
        try {
            const picked = await bridge.pick();
            // 取消了就什么都不做——尤其**不要**接着去索引上一次的选择
            if (!picked) return;
            setStatus(picked);
            setStatus(await bridge.index());
        } catch (err) {
            setError(err instanceof Error ? err.message : String(err));
        }
    }, []);

    const clear = useCallback(async () => {
        const bridge = mediaBridge();
        if (!bridge) return;
        setError(null);
        setWarnings([]);
        setStatus(await bridge.clear());
    }, []);

    return {
        available: mediaBridge() !== null,
        status,
        progress,
        warnings,
        error,
        pickAndIndex,
        clear
    };
}
