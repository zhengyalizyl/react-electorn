import { useCallback, useEffect, useRef, useState } from 'react';

import { describeBridgeError, projectBridge } from '@/renderer/data/bridge';

/**
 * 渲染导出。
 *
 * ## 为什么进度必须是真的
 *
 * 渲染一条几分钟的片子要等很久。转一个假圈的话，用户在第三十秒就会开始怀疑
 * 是不是卡死了——然后关窗口，而那时候编码进行到一半。
 *
 * 成片总时长是已知的，ffmpeg 也会报"已经写出去多少时长"，
 * 所以这里给的是**真百分比**。
 *
 * ## 取消不是失败
 *
 * 用户在保存对话框里点取消是正常操作，不该显示一条红色的错误。
 */

export interface ExportState {
    busy: boolean;
    /** 0–1。没在渲染时是 null */
    ratio: number | null;
    /** 上一次成功导出的文件路径，用来显示"已导出到…" */
    outPath: string | null;
    error: string | null;
    available: boolean;
    run: () => void;
}

export function useExport(dirName: string | undefined): ExportState {
    const [busy, setBusy] = useState(false);
    const [ratio, setRatio] = useState<number | null>(null);
    const [outPath, setOutPath] = useState<string | null>(null);
    const [error, setError] = useState<string | null>(null);

    /** 组件卸载之后别再 setState——渲染可能还在跑 */
    const alive = useRef(true);
    useEffect(() => {
        alive.current = true;
        return () => {
            alive.current = false;
        };
    }, []);

    /**
     * 订阅进度。**必须退订**——不退的话每次重挂载都会再挂一个监听，
     * 表现为进度条越跳越快。
     */
    useEffect(() => {
        const bridge = projectBridge();
        if (!bridge) return;
        return bridge.onExportProgress((event) => {
            if (alive.current) setRatio(event.ratio);
        });
    }, []);

    const run = useCallback(() => {
        const bridge = projectBridge();
        if (!bridge || !dirName || busy) return;

        setBusy(true);
        setError(null);
        setOutPath(null);
        setRatio(0);

        bridge
            .export(dirName)
            .then((result) => {
                if (!alive.current) return;
                // 取消是正常操作，不显示错误；也不显示"已导出到 undefined"
                if (result.status === 'done') setOutPath(result.outPath);
            })
            .catch((cause: unknown) => {
                if (alive.current) setError(describeBridgeError(cause));
            })
            .finally(() => {
                if (!alive.current) return;
                setBusy(false);
                setRatio(null);
            });
    }, [dirName, busy]);

    return {
        busy,
        ratio,
        outPath,
        error,
        available: projectBridge() !== null && dirName !== undefined,
        run
    };
}
