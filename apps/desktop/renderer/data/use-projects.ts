import { useCallback, useEffect, useState } from 'react';

import type { ProjectSummary } from '@/client/agent-ipc';
import { projectBridge } from '@/renderer/data/bridge';

/**
 * 真实工程列表。
 *
 * 数据来自主进程扫 `project.json`（plan.md §9.1：JSON 是唯一真源）。
 * 桌面端之外（组件测试、`ui:shot` 的离屏浏览器）没有桥，此时返回
 * `unavailable`——**而不是空列表**：两者对用户的含义完全不同，
 * 一个是"你还没有项目"，一个是"这里看不到项目"。
 */

export type ProjectsState =
    | { status: 'loading' }
    | { status: 'unavailable' }
    | { status: 'ready'; projects: ProjectSummary[] }
    | { status: 'failed'; message: string };

export interface UseProjects {
    state: ProjectsState;
    reload: () => void;
    remove: (dirName: string) => Promise<void>;
}

export function useProjects(): UseProjects {
    const [state, setState] = useState<ProjectsState>({ status: 'loading' });

    const load = useCallback(() => {
        const bridge = projectBridge();
        if (!bridge) {
            setState({ status: 'unavailable' });
            return;
        }
        setState({ status: 'loading' });
        bridge
            .list()
            .then((projects) => setState({ status: 'ready', projects }))
            .catch((error: unknown) =>
                setState({
                    status: 'failed',
                    message:
                        error instanceof Error ? error.message : String(error)
                })
            );
    }, []);

    useEffect(load, [load]);

    const remove = useCallback(
        async (dirName: string) => {
            const bridge = projectBridge();
            if (!bridge) return;
            await bridge.remove(dirName);
            // 删完重新拉一次，而不是本地过滤：
            // 盘上到底删没删成，只有再扫一遍才知道
            load();
        },
        [load]
    );

    return { state, reload: load, remove };
}

/** `2026-09-23T10:00:00+08:00` → `创建时间 2026-09-23` */
export function formatCreatedAt(iso: string): string {
    const date = new Date(iso);
    if (Number.isNaN(date.getTime())) return '创建时间 未知';
    const y = date.getFullYear();
    const m = String(date.getMonth() + 1).padStart(2, '0');
    const d = String(date.getDate()).padStart(2, '0');
    return `创建时间 ${y}-${m}-${d}`;
}

/**
 * 封面兜底渐变。
 *
 * 真实工程没有封面图（P1 不做抽帧封面）。按 id 取一组确定性配色，
 * 同一个工程在任何时候都是同一张"封面"——用 `Math.random` 的话
 * 每次渲染都换色，看着像 bug。
 */
const COVERS: readonly (readonly [string, string])[] = [
    ['#1B1033', '#0B1F3A'],
    ['#3A2A18', '#1A2230'],
    ['#10262B', '#0E1A2E'],
    ['#2E1630', '#161B33'],
    ['#132A1C', '#101C2A'],
    ['#2B1414', '#1C1526']
];

export function coverFor(id: string): readonly [string, string] {
    let hash = 2166136261;
    for (let i = 0; i < id.length; i += 1) {
        hash ^= id.charCodeAt(i);
        hash = Math.imul(hash, 16777619);
    }
    return COVERS[(hash >>> 0) % COVERS.length]!;
}
