import { useCallback, useEffect, useRef, useState } from 'react';

import { describeBridgeError, voiceBridge } from '@/renderer/data/bridge';

/**
 * 试听：点一下，真用那个音色合成一小段并播出来。
 *
 * ## 为什么状态要分这么细
 *
 * 合成要走一次网络请求，**不是瞬间的事**。只有"在播/没播"两态的话，
 * 用户点下去之后那一两秒里界面毫无反应，他会再点一次、再点一次——
 * 于是排队合成三遍。所以「正在合成」必须是一个看得见的状态。
 *
 * 失败也要单独一态：试听不出声有两种原因（没配凭证 / 请求失败），
 * 二者都比"静悄悄什么也没发生"值得说一句。
 */

export type VoicePreviewPhase = 'idle' | 'loading' | 'playing';

export interface VoicePreviewState {
    /** 正在合成或播放的那个音色。都没有时是 null */
    activeId: string | null;
    phase: VoicePreviewPhase;
    /** 上一次失败的原因。成功一次就清掉 */
    error: string | null;
    /**
     * 合成它的 provider。`mock` 产出的是**长度正确的静音**——
     * 点了试听什么也听不见是正常的，但这件事必须说出来
     */
    provider: string | null;
    /** 能不能试听。没有桥（浏览器、截图环境）时为 false */
    available: boolean;
    /** `speed` 是语速倍率，只有本地引擎认 */
    play: (voiceId: string, speed?: number) => void;
}

export function useVoicePreview(): VoicePreviewState {
    const [activeId, setActiveId] = useState<string | null>(null);
    const [phase, setPhase] = useState<VoicePreviewPhase>('idle');
    const [error, setError] = useState<string | null>(null);
    const [provider, setProvider] = useState<string | null>(null);

    const audioRef = useRef<HTMLAudioElement | null>(null);
    /**
     * 第几次请求。
     *
     * 连点两个音色时，先发的那次可能后回来——不带序号的话，
     * 界面会停在**先点的那个**上，而响的是后点的那个。
     */
    const ticket = useRef(0);

    // 组件卸载时把正在响的那段掐掉。切走页面还在播是实打实的 bug
    useEffect(
        () => () => {
            audioRef.current?.pause();
            audioRef.current = null;
            ticket.current += 1;
        },
        []
    );

    const play = useCallback((voiceId: string, speed?: number) => {
        const bridge = voiceBridge();
        if (!bridge) return;

        // 上一段还在响就先停掉：两个音色叠着放，什么也听不清
        audioRef.current?.pause();
        audioRef.current = null;

        const mine = (ticket.current += 1);
        setActiveId(voiceId);
        setPhase('loading');
        setError(null);

        bridge
            .preview(voiceId, speed)
            .then((result) => {
                // 这次请求已经被后来的那次顶掉了，结果直接丢弃
                if (ticket.current !== mine) return;

                setProvider(result.provider);
                const audio = new Audio(result.dataUrl);
                audioRef.current = audio;
                audio.onended = () => {
                    if (ticket.current !== mine) return;
                    setPhase('idle');
                    setActiveId(null);
                };
                setPhase('playing');
                // 自动播放策略理论上会拒（这是用户点出来的，正常不会），
                // 真被拒也不该让整页崩
                const started: unknown = audio.play();
                if (started instanceof Promise) {
                    void started.catch(() => {
                        if (ticket.current !== mine) return;
                        setPhase('idle');
                        setActiveId(null);
                    });
                }
            })
            .catch((cause: unknown) => {
                if (ticket.current !== mine) return;
                setError(describeBridgeError(cause));
                setPhase('idle');
                setActiveId(null);
            });
    }, []);

    return {
        activeId,
        phase,
        error,
        provider,
        available: voiceBridge() !== null,
        play
    };
}
