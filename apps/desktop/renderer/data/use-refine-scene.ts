import { useCallback, useEffect, useRef, useState } from 'react';

import type { VideoProject } from '@magicut-react-demo/video-project';

import type { RefineStage } from '@/client/agent-ipc';
import { describeBridgeError, projectBridge } from '@/renderer/data/bridge';

/**
 * 「按一句要求改这一镜」。
 *
 * ## 为什么进度要分三档
 *
 * 这一步先调模型想词（几秒）、再合成（又几秒）、最后重排。只有"在转圈/没在转圈"
 * 的话，用户不知道是在想词还是在念，等上十几秒就会去点别的地方，
 * 而那时候模型那次调用的钱已经花掉了。
 *
 * ## 为什么跑的时候要锁住
 *
 * 调模型与合成都按量计费。不锁的话，用户在等待时再按一次 Enter 就是
 * **再花一遍钱**，而且两次重排会打架——后回来的那次会把前一次的结果盖掉，
 * 中间那份改动就这么没了。
 */

/** 三档进度各自对应的那句话。直接写成文案，省得每个调用方各翻译一遍 */
const STAGE_LABEL: Record<RefineStage, string> = {
    rewriting: '正在改写这一镜的文案…',
    synthesizing: '正在用原来的音色重念…',
    relayout: '正在重排时间线…'
};

export interface RefineSceneState {
    busy: boolean;
    /** 当前这一步在干什么。没在跑时是 null */
    stage: string | null;
    error: string | null;
    /** 能不能用。没有桥（浏览器）或没有工程目录时为 false */
    available: boolean;
    /** `speed` 是语速倍率，跟着整条片子走——只有本地引擎认 */
    run: (
        sceneId: string,
        instruction: string,
        speed?: number
    ) => Promise<void>;
}

export function useRefineScene(options: {
    /** 工程目录名。没有就没法写回去 */
    dirName: string | undefined;
    /** 改完把新工程交给页面 */
    onDone: (project: VideoProject) => void;
}): RefineSceneState {
    const [busy, setBusy] = useState(false);
    const [stage, setStage] = useState<string | null>(null);
    const [error, setError] = useState<string | null>(null);

    const { dirName, onDone } = options;
    // onDone 每次渲染都是新函数，放进 ref 免得订阅跟着重建
    const done = useRef(onDone);
    done.current = onDone;

    /**
     * 订阅进度。**必须退订**——不退的话每次重挂载都会再挂一个监听，
     * 表现为同一条进度被处理好几遍。
     */
    useEffect(() => {
        const bridge = projectBridge();
        if (!bridge) return;
        return bridge.onRefineProgress((next) => setStage(STAGE_LABEL[next]));
    }, []);

    const run = useCallback(
        async (
            sceneId: string,
            instruction: string,
            speed?: number
        ): Promise<void> => {
            const bridge = projectBridge();
            if (!bridge || !dirName || busy) return;

            setBusy(true);
            setError(null);
            setStage('正在准备…');

            try {
                done.current(
                    await bridge.refineScene(
                        dirName,
                        sceneId,
                        instruction,
                        speed
                    )
                );
            } catch (cause: unknown) {
                setError(describeBridgeError(cause));
                /**
                 * 记下原因之后**还要再抛出去**。
                 *
                 * `error` 是给界面显示的，而抛出去是为了让输入框知道这次没成——
                 * 它据此把用户打的那句话留着。咽掉的话，一次失败就让他
                 * 白打一遍，而那句要求往往是斟酌过措辞的。
                 */
                throw cause;
            } finally {
                setBusy(false);
                setStage(null);
            }
        },
        [dirName, busy]
    );

    return {
        busy,
        stage,
        error,
        available: projectBridge() !== null && dirName !== undefined,
        run
    };
}
