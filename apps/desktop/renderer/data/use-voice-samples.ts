import { useCallback, useEffect, useRef, useState } from 'react';

import type { VoiceEngineStatus, VoiceSample } from '@/client/agent-ipc';
import { describeBridgeError, voiceBridge } from '@/renderer/data/bridge';

/**
 * 自定义音色库。
 *
 * 选文件、量时长、进库、试听、删除、**拿它合成口播**——都是真的，
 * 关掉应用再打开还在。
 *
 * 合成走本地 IndexTTS2（零样本克隆：不训练、不注册，传完当场能用）。
 * 它是用户自己机器上的服务，**随时可能没开**，所以 `engine` 要和样本列表
 * 一样当成一等状态：界面得能说出"现在用不了，因为什么"，
 * 而不是让用户点了生成再等一个失败。
 */

export interface VoiceSamplesState {
    samples: VoiceSample[];
    /** 正在开文件框或处理文件 */
    busy: boolean;
    /** 正在试听的那个样本 id */
    playingId: string | null;
    error: string | null;
    available: boolean;
    /**
     * 本地复刻引擎的状态。**还没探到时是 null**——
     * 这和"探过了，不可用"不是一回事：前者不该在界面上说任何话。
     */
    engine: VoiceEngineStatus | null;
    add: () => void;
    remove: (id: string) => void;
    play: (id: string) => void;
    /** 重新探一次引擎。用户去把服务启起来之后会回来点它 */
    recheckEngine: () => void;
}

export function useVoiceSamples(): VoiceSamplesState {
    const [samples, setSamples] = useState<VoiceSample[]>([]);
    const [busy, setBusy] = useState(false);
    const [playingId, setPlayingId] = useState<string | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [engine, setEngine] = useState<VoiceEngineStatus | null>(null);

    const audioRef = useRef<HTMLAudioElement | null>(null);
    const alive = useRef(true);

    useEffect(() => {
        alive.current = true;
        return () => {
            alive.current = false;
            // 切走页面还在响是实打实的 bug
            audioRef.current?.pause();
            audioRef.current = null;
        };
    }, []);

    // 进来先把库读出来。读失败不报红——空库和读不出来对用户是同一件事
    useEffect(() => {
        const bridge = voiceBridge();
        if (!bridge) return;
        void bridge.samples
            .list()
            .then((list) => {
                if (alive.current) setSamples(list);
            })
            .catch(() => undefined);
    }, []);

    /**
     * 探一次本地复刻引擎。
     *
     * 它是用户自己机器上的服务，**随时可能没开**。不先探的话，用户会选好
     * 自定义音色、点生成、等上几秒，再换来一个"连不上"——而那几秒里他以为
     * 是在合成。提前探一下，界面就能在他动手之前说清楚。
     *
     * **探测失败也要落成一个状态**，不能留在 null：null 的含义是"还没探"，
     * 界面据此什么都不说；探过了用不了是另一回事，那要说出来。
     */
    const recheckEngine = useCallback(() => {
        const bridge = voiceBridge();
        if (!bridge) return;

        void bridge.samples
            .engine()
            .then((status) => {
                if (alive.current) setEngine(status);
            })
            .catch((cause: unknown) => {
                if (!alive.current) return;
                // 连这条通道都没有（开发时主进程不热更新）同样是"用不了"，
                // 而 describeBridgeError 给的那句"重启应用即可"正好是要说的话
                setEngine({ ready: false, reason: describeBridgeError(cause) });
            });
    }, []);

    useEffect(recheckEngine, [recheckEngine]);

    const add = useCallback(() => {
        const bridge = voiceBridge();
        if (!bridge || busy) return;

        setBusy(true);
        setError(null);
        bridge.samples
            .add()
            .then((list) => {
                if (alive.current) setSamples(list);
            })
            .catch((cause: unknown) => {
                if (alive.current) setError(describeBridgeError(cause));
            })
            .finally(() => {
                if (alive.current) setBusy(false);
            });
    }, [busy]);

    const remove = useCallback((id: string) => {
        const bridge = voiceBridge();
        if (!bridge) return;

        setError(null);
        void bridge.samples
            .remove(id)
            .then((list) => {
                if (alive.current) setSamples(list);
            })
            .catch((cause: unknown) => {
                if (alive.current) setError(describeBridgeError(cause));
            });
    }, []);

    const play = useCallback((id: string) => {
        const bridge = voiceBridge();
        if (!bridge) return;

        // 上一段还在响就先停掉：两段叠着放什么也听不清
        audioRef.current?.pause();
        audioRef.current = null;
        setPlayingId(id);
        setError(null);

        void bridge.samples
            .read(id)
            .then((result) => {
                if (!alive.current) return;
                const audio = new Audio(result.dataUrl);
                audioRef.current = audio;
                audio.onended = () => {
                    if (alive.current) setPlayingId(null);
                };
                const started: unknown = audio.play();
                if (started instanceof Promise) {
                    void started.catch(() => {
                        if (alive.current) setPlayingId(null);
                    });
                }
            })
            .catch((cause: unknown) => {
                if (!alive.current) return;
                setError(describeBridgeError(cause));
                setPlayingId(null);
            });
    }, []);

    return {
        samples,
        busy,
        playingId,
        error,
        available: voiceBridge() !== null,
        engine,
        add,
        remove,
        play,
        recheckEngine
    };
}
