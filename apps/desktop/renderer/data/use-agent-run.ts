import { useCallback, useEffect, useRef, useState } from 'react';

import type {
    AgentRunEvent,
    MatchPreview,
    ScenePreview
} from '@/client/agent-ipc';
import { agentBridge, describeBridgeError } from '@/renderer/data/bridge';
import { labelOfNode } from '@/renderer/data/node-labels';
import type { RunMessage } from '@/renderer/data/run-messages';
import {
    initialMessages,
    messagesAfterEvent,
    messagesAfterReply
} from '@/renderer/data/run-messages';

/**
 * 一次创作的进度状态（B10）。
 *
 * 事件从主进程推过来，这里只做累积与归类。**不在这里做任何业务判断**——
 * 图的状态机在主进程，渲染层重复一份只会两边不一致。
 */

export type RunPhase =
    | 'idle'
    | 'unavailable'
    | 'running'
    | 'awaiting_requirements'
    | 'awaiting_scenes'
    | 'awaiting_matches'
    | 'finished'
    | 'failed';

export interface RunLogItem {
    /** 用 `${type}:${节点}:${序号}` 做 key，节点会重复出现（repair 环） */
    key: string;
    text: string;
    kind: 'step' | 'decision' | 'warning';
}

export interface AgentRunState {
    phase: RunPhase;
    runId: string | null;
    /** 当前节点，界面上显示"正在做什么" */
    node: string | null;
    log: RunLogItem[];
    scenes: ScenePreview[];
    matches: MatchPreview[];
    savedPath: string | null;
    error: string | null;
}

const INITIAL: AgentRunState = {
    phase: 'idle',
    runId: null,
    node: null,
    log: [],
    scenes: [],
    matches: [],
    savedPath: null,
    error: null
};

export interface UseAgentRun extends AgentRunState {
    available: boolean;
    /** 聊天记录（设计稿 W8bPLG）。只追加，key 稳定 */
    messages: RunMessage[];
    start: (prompt: string, voiceId?: string) => Promise<void>;
    approveRequirements: () => Promise<void>;
    approveScenes: (scripts?: string[]) => Promise<void>;
    approveMatches: (rejectedIndexes?: number[]) => Promise<void>;
    cancel: () => Promise<void>;
    reset: () => void;
    /**
     * 分镜确认那几个文本框里**当前的字**。
     *
     * 提到这一层而不是留在 `SceneApproval` 自己身上：底部那个输入框
     * 也要往里写（用一句话让模型改一版）。两边各存一份的话，
     * 用一句话改完之后文本框里还是旧的，而用户看不出哪个才算数。
     */
    sceneDrafts: string[];
    setSceneDraft: (index: number, text: string) => void;
    /**
     * 按一句要求让模型把这一版文案改一改，结果填进上面那几个文本框。
     *
     * **不替用户点头**：改完要让他看见再决定放不放行——放行之后
     * 配素材与合成的钱就花出去了。
     */
    reviseScenes: (instruction: string) => Promise<void>;
    /** 正在让模型改写 */
    revising: boolean;
    /** 上一次改写失败的原因 */
    reviseError: string | null;
}

export function useAgentRun(): UseAgentRun {
    const [state, setState] = useState<AgentRunState>(INITIAL);
    // 聊天记录与运行状态分开存：状态是当前快照（scenes 会被下一次中断覆盖），
    // 记录要的是历史。硬塞进一个会逼着组件到处 if
    const [messages, setMessages] = useState<RunMessage[]>([]);
    // 事件序号只用来生成稳定 key，不进渲染逻辑，所以放 ref 不放 state
    const seq = useRef(0);

    useEffect(() => {
        const bridge = agentBridge();
        if (!bridge) {
            setState((prev) => ({ ...prev, phase: 'unavailable' }));
            return;
        }

        // **必须退订。** 不退订的话每次挂载都会再加一个监听器，
        // 切几次页面之后同一个事件会被处理多次（plan.md §12.3）
        return bridge.onEvent((event) => {
            seq.current += 1;
            const at = seq.current;
            setState((prev) => reduce(prev, event, at));
            setMessages((prev) => messagesAfterEvent(prev, event, at));
        });
    }, []);

    const start = useCallback(async (prompt: string, voiceId?: string) => {
        const bridge = agentBridge();
        if (!bridge) return;
        seq.current = 0;
        setState({ ...INITIAL, phase: 'running' });
        setMessages(initialMessages({ script: prompt, voiceId }));
        try {
            const { runId } = await bridge.start(prompt, voiceId);
            setState((prev) => ({ ...prev, runId }));
        } catch (error) {
            setState((prev) => ({
                ...prev,
                phase: 'failed',
                error: error instanceof Error ? error.message : String(error)
            }));
        }
    }, []);

    const answer = useCallback(
        async (
            payload: Parameters<
                NonNullable<ReturnType<typeof agentBridge>>['approve']
            >[1],
            /** 记录里那条右侧气泡写什么 */
            reply: string
        ) => {
            const bridge = agentBridge();
            if (!bridge || !state.runId) return;
            // 先切回 running，按钮才不会在等待响应时还能再点一次
            setState((prev) => ({ ...prev, phase: 'running' }));
            seq.current += 1;
            const at = seq.current;
            setMessages((prev) => messagesAfterReply(prev, reply, at));
            try {
                await bridge.approve(state.runId, payload);
            } catch (error) {
                setState((prev) => ({
                    ...prev,
                    phase: 'failed',
                    error:
                        error instanceof Error ? error.message : String(error)
                }));
            }
        },
        [state.runId]
    );

    /** 需求文档只有放行一个动作：要改得回去改提示词 */
    const approveRequirements = useCallback(async () => {
        await answer(
            { node: 'RequirementApproval', action: 'approve' },
            '确认，按这个做'
        );
    }, [answer]);

    const approveScenes = useCallback(
        async (scripts?: string[]) => {
            await answer(
                scripts
                    ? { node: 'SceneApproval', action: 'modify', scripts }
                    : { node: 'SceneApproval', action: 'approve' },
                scripts ? '用修改后的文案' : '就这样，继续'
            );
        },
        [answer]
    );

    const approveMatches = useCallback(
        async (rejectedIndexes?: number[]) => {
            const rejected = rejectedIndexes ?? [];
            await answer(
                rejected.length > 0
                    ? {
                          node: 'MatchApproval',
                          action: 'reject',
                          rejectedIndexes: rejected
                      }
                    : { node: 'MatchApproval', action: 'approve' },
                rejected.length > 0
                    ? `重挑标记的 ${rejected.length} 个`
                    : '就这样，继续'
            );
        },
        [answer]
    );

    /**
     * 分镜确认那几个文本框里当前的字。
     *
     * **每次停到分镜确认都重铺一次**：上一轮改过的字留着的话，
     * 用户会对着一版早就不存在的文案做决定。
     */
    const [sceneDrafts, setSceneDrafts] = useState<string[]>([]);
    const [revising, setRevising] = useState(false);
    const [reviseError, setReviseError] = useState<string | null>(null);

    useEffect(() => {
        if (state.phase !== 'awaiting_scenes') return;
        setSceneDrafts(state.scenes.map((scene) => scene.script));
        setReviseError(null);
    }, [state.phase, state.scenes]);

    const setSceneDraft = useCallback((index: number, text: string) => {
        setSceneDrafts((prev) =>
            prev.map((item, i) => (i === index ? text : item))
        );
    }, []);

    const reviseScenes = useCallback(
        async (instruction: string) => {
            const bridge = agentBridge();
            if (!bridge || revising) return;

            setRevising(true);
            setReviseError(null);
            try {
                // 发出去的是**文本框里当前的字**，不是图给的原版——
                // 用户可能已经手改过几条，那几条不该被这次改写冲掉
                setSceneDrafts(
                    await bridge.reviseScenes(instruction, sceneDrafts)
                );
            } catch (cause: unknown) {
                setReviseError(describeBridgeError(cause));
                /**
                 * 记下原因之后**还要再抛出去**。
                 *
                 * `reviseError` 是给界面显示的；抛出去是为了让输入框知道
                 * 这次没成，它据此把用户打的那句话留着。咽掉的话，
                 * 一次失败就让他白打一遍。
                 */
                throw cause;
            } finally {
                setRevising(false);
            }
        },
        [revising, sceneDrafts]
    );

    const cancel = useCallback(async () => {
        const bridge = agentBridge();
        if (!bridge || !state.runId) return;
        await bridge.cancel(state.runId);
    }, [state.runId]);

    const reset = useCallback(() => {
        seq.current = 0;
        setState({ ...INITIAL, phase: agentBridge() ? 'idle' : 'unavailable' });
        setMessages([]);
    }, []);

    return {
        ...state,
        messages,
        available: state.phase !== 'unavailable',
        start,
        approveRequirements,
        approveScenes,
        approveMatches,
        cancel,
        reset,
        sceneDrafts,
        setSceneDraft,
        reviseScenes,
        revising,
        reviseError
    };
}

/** 纯归约。导出是为了能脱离 React 直接测事件处理 */
export function reduce(
    prev: AgentRunState,
    event: AgentRunEvent,
    seq: number
): AgentRunState {
    // 只认当前这次运行的事件。上一次运行的迟到事件不该改现在的界面
    if (prev.runId !== null && event.runId !== prev.runId) return prev;

    switch (event.type) {
        case 'node_start':
            return {
                ...prev,
                node: event.node,
                log: [
                    ...prev.log,
                    {
                        key: `s:${event.node}:${seq}`,
                        text: labelOfNode(event.node),
                        kind: 'step'
                    }
                ]
            };
        case 'decision':
            return {
                ...prev,
                log: [
                    ...prev.log,
                    {
                        key: `d:${event.node}:${seq}`,
                        text: event.summary,
                        kind: 'decision'
                    }
                ]
            };
        case 'warning':
            return {
                ...prev,
                log: [
                    ...prev.log,
                    {
                        key: `w:${event.node}:${seq}`,
                        text: event.message,
                        kind: 'warning'
                    }
                ]
            };
        case 'awaiting_requirements':
            return { ...prev, phase: 'awaiting_requirements' };
        case 'awaiting_scenes':
            return { ...prev, phase: 'awaiting_scenes', scenes: event.scenes };
        case 'awaiting_matches':
            return {
                ...prev,
                phase: 'awaiting_matches',
                matches: event.matches
            };
        case 'finished':
            return { ...prev, phase: 'finished', savedPath: event.savedPath };
        case 'error':
            return { ...prev, phase: 'failed', error: event.message };
        case 'cancelled':
            return { ...prev, phase: 'idle' };
        default:
            return prev;
    }
}
