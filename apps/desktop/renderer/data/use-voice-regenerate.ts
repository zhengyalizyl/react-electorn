import { useCallback, useEffect, useRef, useState } from 'react';

import type { VideoProject } from '@magicut-react-demo/video-project';

import { describeBridgeError, voiceBridge } from '@/renderer/data/bridge';

/**
 * 「生成口播稿」：用选中的音色把整条片子的口播重新合成一遍。
 *
 * ## 为什么必须有进度
 *
 * 九个分镜要**逐个**合成，每个都是一次网络请求。只有"在转圈/没在转圈"的话，
 * 用户不知道是快好了还是卡住了——等上一分钟就会去点取消或者关窗口，
 * 而那时候前面几镜的钱已经花掉了。
 *
 * ## 为什么重算期间要锁住按钮
 *
 * 合成按量计费。按钮不锁的话，用户在等待时再点一次就是**再花一遍钱**，
 * 而且两次重排会打架。
 */

export interface VoiceRegenerateState {
    busy: boolean;
    /** 合成到第几镜。没在跑时是 null */
    progress: { done: number; total: number; label: string } | null;
    error: string | null;
    /** 能不能用。没有桥（浏览器）或没有工程目录时为 false */
    available: boolean;
    /** `speed` 是语速倍率，只有本地引擎认 */
    run: (voiceId: string, speed?: number) => void;
}

export function useVoiceRegenerate(options: {
    /** 工程目录名。没有就没法写回去 */
    dirName: string | undefined;
    /** 生成完把新工程交给页面 */
    onDone: (project: VideoProject) => void;
}): VoiceRegenerateState {
    const [busy, setBusy] = useState(false);
    const [progress, setProgress] =
        useState<VoiceRegenerateState['progress']>(null);
    const [error, setError] = useState<string | null>(null);

    const { dirName, onDone } = options;
    // onDone 每次渲染都是新函数，放进 ref 免得订阅跟着重建
    const done = useRef(onDone);
    done.current = onDone;

    /**
     * 订阅进度。**必须退订**——不退的话每次重挂载都会再挂一个监听，
     * 表现为进度条越跳越快。
     */
    useEffect(() => {
        const bridge = voiceBridge();
        if (!bridge) return;
        return bridge.onProgress(setProgress);
    }, []);

    const run = useCallback(
        (voiceId: string, speed?: number) => {
            const bridge = voiceBridge();
            if (!bridge || !dirName || busy) return;

            setBusy(true);
            setError(null);
            setProgress({ done: 0, total: 0, label: '准备合成' });

            bridge
                .regenerate(dirName, voiceId, speed)
                .then((project) => done.current(project))
                .catch((cause: unknown) => setError(describeBridgeError(cause)))
                .finally(() => {
                    setBusy(false);
                    setProgress(null);
                });
        },
        [dirName, busy]
    );

    return {
        busy,
        progress,
        error,
        available: voiceBridge() !== null && dirName !== undefined,
        run
    };
}
