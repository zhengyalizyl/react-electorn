import { useEffect, useState } from 'react';

import type { VideoProject } from '@magicut-react-demo/video-project';

import { projectBridge } from '@/renderer/data/bridge';

/**
 * 按目录名加载一个真实工程（B11）。
 *
 * 状态分得比"有/没有"细，因为**这四种情况对用户要说的话完全不同**：
 * 正在读、这里读不了、这个工程不存在、读出来了。统一成"空"会让人
 * 在浏览器里以为自己的工程丢了。
 */

export type ProjectState =
    | { status: 'none' }
    | { status: 'loading' }
    | { status: 'unavailable' }
    | { status: 'failed'; message: string }
    | { status: 'ready'; project: VideoProject };

export function useProject(dirName: string | undefined): ProjectState & {
    /** 重新读一遍。写过工程之后要用它把界面跟上 */
    reload: () => void;
} {
    const [state, setState] = useState<ProjectState>(
        dirName ? { status: 'loading' } : { status: 'none' }
    );
    // 换一个值就触发一次重读。比把 load 抽成函数再到处传简单得多
    const [tick, setTick] = useState(0);

    useEffect(() => {
        if (!dirName) {
            setState({ status: 'none' });
            return;
        }
        const bridge = projectBridge();
        if (!bridge) {
            setState({ status: 'unavailable' });
            return;
        }

        // 切走之后迟到的响应不该再改状态——否则会把上一个工程盖到当前界面上
        let alive = true;
        setState({ status: 'loading' });
        bridge
            .load(dirName)
            .then((project) => {
                if (alive) setState({ status: 'ready', project });
            })
            .catch((error: unknown) => {
                if (!alive) return;
                setState({
                    status: 'failed',
                    message:
                        error instanceof Error ? error.message : String(error)
                });
            });

        return () => {
            alive = false;
        };
    }, [dirName, tick]);

    return { ...state, reload: () => setTick((value) => value + 1) };
}
