import { useEffect, useRef, useState } from 'react';

import type { SaveState } from '@/renderer/components/editor/EditorHeader';
import { describeBridgeError } from '@/renderer/data/bridge';

/**
 * 自动落盘：停手之后写一次。
 *
 * ## 为什么要防抖
 *
 * 拖一次滑杆连发几十个值，每个都写一次 `project.json` 是在拿磁盘换手感。
 * 停手之后再写，并且**只写最后那一下**——中间那些值用户根本没打算要。
 *
 * ## 为什么是自动保存而不是「应用」按钮
 *
 * 设计稿里没有那颗按钮，加一个等于改设计；而且会多出一种更糟的状态：
 * 改了、看见了、**但忘了点应用**——下次打开发现白改了，
 * 用户还会以为是程序没存住。
 *
 * ## 失败必须说出口
 *
 * **静悄悄地失败是最糟的表现**：用户以为存住了，下次打开发现没有，
 * 而中间没有任何一处说过话。所以这里把失败原因留给调用方去显示。
 */

export interface AutoSaveState {
    /** 没存过东西时是 null——**没在存就别声称"已保存"** */
    state: SaveState | null;
    error: string | null;
}

export function useAutoSave<T>(
    /**
     * 触发源。**必须是个引用稳定的值**（通常就是那块 state）：
     * 每次渲染都新建的对象会让定时器反复重建，于是永远到不了点。
     */
    trigger: T,
    /**
     * 真正要做的事。不需要存时传 null——
     * 「和盘上那份一样」「没有去处」都走这一条，调用方自己判。
     */
    run: (() => Promise<void>) | null,
    delayMs = 600
): AutoSaveState {
    const [state, setState] = useState<SaveState | null>(null);
    const [error, setError] = useState<string | null>(null);

    /**
     * `run` 每次渲染都是新函数，列进依赖会让定时器反复重建。
     * 放进 ref：定时器只认 `trigger`，到点时再取**最新的**那个 run。
     */
    const latest = useRef(run);
    latest.current = run;

    useEffect(() => {
        if (!latest.current) return;

        const timer = setTimeout(() => {
            const fn = latest.current;
            // 这几百毫秒里可能已经变成"不用存了"（比如被撤销回原值）
            if (!fn) return;

            setState('saving');
            void fn()
                .then(() => {
                    setError(null);
                    setState('saved');
                })
                .catch((cause: unknown) => {
                    setError(describeBridgeError(cause));
                    setState('failed');
                });
        }, delayMs);

        return () => clearTimeout(timer);
    }, [trigger, delayMs]);

    return { state, error };
}
