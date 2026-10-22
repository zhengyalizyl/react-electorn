import { useCallback, useEffect, useRef, useState } from 'react';

import type {
    ActiveClips,
    VideoProject
} from '@magicut-react-demo/video-project';
import { clipsAt } from '@magicut-react-demo/video-project';

/**
 * 预览播放的时钟。
 *
 * ## 时钟是自己的，不是 `<video>` 的
 *
 * 一条片子由多段素材接起来，中间可能有没配上画面的分镜。
 * 跟着 `<video>` 的 `timeupdate` 走的话，**那些没有画面的段落时间就不走了**。
 * 所以这里用 `requestAnimationFrame` 自己推进播放头，
 * 媒体元素只负责"被对齐到播放头"。
 *
 * ## 为什么不用 setInterval
 *
 * rAF 跟着屏幕刷新走，切到后台会自动停——不会在用户看不见的时候空转。
 */

export interface PreviewState {
    /** 播放头，毫秒 */
    timeMs: number;
    playing: boolean;
    durationMs: number;
    active: ActiveClips;
    play: () => void;
    pause: () => void;
    toggle: () => void;
    /** 拖进度条 */
    seek: (timeMs: number) => void;
}

export function usePreview(project: VideoProject | null): PreviewState {
    const [timeMs, setTimeMs] = useState(0);
    const [playing, setPlaying] = useState(false);

    const durationMs = project?.canvas.durationMs ?? 0;
    // 播放头放在 ref 里推进，state 只用于渲染——
    // 每帧 setState 再读 state 会拿到上一帧的值
    const headRef = useRef(0);
    const lastFrameRef = useRef(0);

    useEffect(() => {
        headRef.current = 0;
        setTimeMs(0);
        setPlaying(false);
    }, [project]);

    useEffect(() => {
        if (!playing || durationMs === 0) return;

        let raf = 0;
        lastFrameRef.current = performance.now();

        const step = (now: number) => {
            const delta = now - lastFrameRef.current;
            lastFrameRef.current = now;
            const next = headRef.current + delta;

            if (next >= durationMs) {
                // 播到头就停在末尾，**不自动回到 0**——
                // 回到 0 的话用户分不清"播完了"和"没开始"
                headRef.current = durationMs;
                setTimeMs(durationMs);
                setPlaying(false);
                return;
            }

            headRef.current = next;
            setTimeMs(next);
            raf = requestAnimationFrame(step);
        };

        raf = requestAnimationFrame(step);
        return () => cancelAnimationFrame(raf);
    }, [playing, durationMs]);

    const seek = useCallback(
        (next: number) => {
            const clamped = Math.min(Math.max(0, next), durationMs);
            headRef.current = clamped;
            setTimeMs(clamped);
        },
        [durationMs]
    );

    const play = useCallback(() => {
        // 播完之后再点播放：从头开始，而不是卡在末尾一动不动
        if (headRef.current >= durationMs && durationMs > 0) {
            headRef.current = 0;
            setTimeMs(0);
        }
        setPlaying(true);
    }, [durationMs]);

    const pause = useCallback(() => setPlaying(false), []);
    const toggle = useCallback(
        () => (playing ? pause() : play()),
        [playing, pause, play]
    );

    return {
        timeMs,
        playing,
        durationMs,
        active: project
            ? clipsAt(project, timeMs)
            : { video: null, voice: null, subtitle: null, music: null },
        play,
        pause,
        toggle,
        seek
    };
}
