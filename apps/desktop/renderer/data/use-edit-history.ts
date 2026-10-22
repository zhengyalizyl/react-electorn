import { useCallback, useRef, useState } from 'react';

/**
 * 编辑历史：撤销 / 重做。
 *
 * ## 为什么历史要"合并"
 *
 * 拖一次字号滑杆连发几十个值。每个值都压一条历史的话，用户按一次撤销只退回
 * 一个像素，要按四十次才回到动手之前——那不叫撤销，那叫折磨。
 *
 * 合并的判据是 `mergeKey`：**相邻两次改的是同一样东西就并成一条**。
 * 拖滑杆期间 key 一直是 `fontSize`，于是整段拖动只占一条；
 * 中间点了色卡（key 变成 `swatch`）就断开，再拖滑杆是新的一条。
 *
 * 不用时间窗口是刻意的：定时器会让"撤销退回到哪一步"依赖于用户手速，
 * 同一串操作在快机器和慢机器上结果不同，而且测试里要靠假时钟才跑得了。
 * 按内容合并是确定的。
 *
 * ## 为什么 present 不在这里持有
 *
 * 当前值由调用方自己的 state 持有（它还要喂给预览、喂给保存）。
 * 这里只管两摞历史，`undo`/`redo` 返回"应该变成什么"，由调用方写回去。
 * 两边各存一份当前值，迟早会对不上。
 */

export interface EditHistory<T> {
    canUndo: boolean;
    canRedo: boolean;
    /**
     * 记一步。
     *
     * @param previous 改之前的值——**压进历史的是旧值**，撤销要回到的就是它
     * @param mergeKey 改的是哪一样东西。与上一条相同就合并，不新增一条
     */
    push: (previous: T, mergeKey: string) => void;
    /** 返回应该恢复成的值；没得撤销时返回 null。`current` 会被推进重做栈 */
    undo: (current: T) => T | null;
    redo: (current: T) => T | null;
    /** 换了工程时清空——上一个工程的历史退到这个工程上只会制造垃圾数据 */
    reset: () => void;
}

interface Entry<T> {
    value: T;
    mergeKey: string;
}

export function useEditHistory<T>(): EditHistory<T> {
    const past = useRef<Entry<T>[]>([]);
    const future = useRef<Entry<T>[]>([]);
    // ref 存数据、state 只用来触发重渲染：按钮的禁用态要跟着变
    const [, bump] = useState(0);
    const refresh = useCallback(() => bump((n) => n + 1), []);

    const push = useCallback(
        (previous: T, mergeKey: string) => {
            const top = past.current[past.current.length - 1];
            // **新动作会砍掉重做栈**：撤销几步之后又改了别的，
            // 那条分支就不存在了，留着它只会让重做跳到一个没人见过的状态
            future.current = [];

            if (top && top.mergeKey === mergeKey) {
                // 合并：保留**最早**那个旧值，撤销才会一次退回到动手之前
                refresh();
                return;
            }

            past.current = [...past.current, { value: previous, mergeKey }];
            refresh();
        },
        [refresh]
    );

    const undo = useCallback(
        (current: T): T | null => {
            const top = past.current[past.current.length - 1];
            if (!top) return null;

            past.current = past.current.slice(0, -1);
            future.current = [
                ...future.current,
                { value: current, mergeKey: top.mergeKey }
            ];
            refresh();
            return top.value;
        },
        [refresh]
    );

    const redo = useCallback(
        (current: T): T | null => {
            const top = future.current[future.current.length - 1];
            if (!top) return null;

            future.current = future.current.slice(0, -1);
            past.current = [
                ...past.current,
                { value: current, mergeKey: top.mergeKey }
            ];
            refresh();
            return top.value;
        },
        [refresh]
    );

    const reset = useCallback(() => {
        past.current = [];
        future.current = [];
        refresh();
    }, [refresh]);

    return {
        canUndo: past.current.length > 0,
        canRedo: future.current.length > 0,
        push,
        undo,
        redo,
        reset
    };
}
