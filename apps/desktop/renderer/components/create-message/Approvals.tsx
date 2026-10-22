import { useEffect, useState } from 'react';

import type { UseAgentRun } from '@/renderer/data/use-agent-run';

/**
 * 两个中断点的确认界面（plan.md §6）。
 *
 * 图**真的会停在这里**等答复：不点，主进程那条运行就一直挂着。
 * 所以两个按钮的语义必须分得很清——「就这样，继续」是放行，
 * 另一个才是把改动带上去。
 *
 * 原先它们长在 `RunPanel` 里；创作进行页改成设计稿的消息流之后，
 * 那个外壳（标题 + 日志）不再需要，只留下这两段。配色跟着换成 msg-*。
 */

/**
 * 需求文档的确认。**只有放行一个动作**——文档是前面几步的汇总，
 * 要改得回去改提示词；在这一页改一行字并不会让模型换个思路去拆分镜，那只是自欺。
 */
export function RequirementApproval({ run }: { run: UseAgentRun }) {
    return (
        <section aria-label="确认需求" className="flex items-center gap-3">
            <button
                type="button"
                onClick={() => void run.approveRequirements()}
                className="flex h-11 cursor-pointer items-center justify-center rounded-[10px] bg-linear-to-r from-[#F06AB0] to-[#8A5CFF] px-6 text-ed-md font-bold text-ed-text"
            >
                确认，按这个做
            </button>
            <span className="text-ed-sm text-ed-text-2">
                往后每一步都要调模型。理解错了的话，在这儿打住最省。
            </span>
        </section>
    );
}

export function SceneApproval({ run }: { run: UseAgentRun }) {
    /**
     * 文本框里的字**由 `useAgentRun` 持有**，不存在这个组件身上。
     *
     * 底部那个输入框也要往里写（用一句话让模型改一版）。各存一份的话，
     * 用一句话改完之后这几个框里还是旧的，而用户看不出哪个才算数。
     */
    const scripts = run.sceneDrafts;

    const changed = run.scenes.some(
        (scene, i) => scripts[i] !== undefined && scripts[i] !== scene.script
    );

    return (
        <section aria-label="确认分镜" className="flex flex-col gap-4">
            <h3 className="text-[19px] font-bold text-ed-text">
                确认分镜（{run.scenes.length} 段）
            </h3>
            <ul className="flex max-h-[320px] flex-col gap-3 overflow-y-auto scrollbar-ed">
                {run.scenes.map((scene, index) => (
                    <li
                        key={`${scene.goal}-${index}`}
                        className="flex flex-col gap-2 rounded-xl border border-msg-border p-3.5"
                    >
                        <div className="flex items-center justify-between">
                            <span className="text-ed-sm text-ed-text-2">
                                分镜 {String(index + 1).padStart(2, '0')} ·{' '}
                                {scene.goal}
                            </span>
                            <span className="text-ed-xs text-ed-text-3">
                                {scene.visualIntent}
                            </span>
                        </div>
                        <textarea
                            aria-label={`分镜 ${index + 1} 文案`}
                            value={scripts[index] ?? ''}
                            onChange={(event) =>
                                run.setSceneDraft(index, event.target.value)
                            }
                            className="min-h-[64px] w-full resize-none bg-transparent text-ed-md leading-ed text-ed-text caret-[#F2F2F5] outline-none"
                        />
                    </li>
                ))}
            </ul>
            <div className="flex items-center gap-3">
                <button
                    type="button"
                    onClick={() => void run.approveScenes()}
                    className="flex h-11 cursor-pointer items-center justify-center rounded-[10px] bg-linear-to-r from-[#F06AB0] to-[#8A5CFF] px-6 text-ed-md font-bold text-ed-text"
                >
                    就这样，继续
                </button>
                <button
                    type="button"
                    disabled={!changed}
                    onClick={() => void run.approveScenes(scripts)}
                    className="flex h-11 cursor-pointer items-center justify-center rounded-[10px] border border-msg-border px-6 text-ed-md text-ed-text disabled:cursor-not-allowed disabled:opacity-40"
                >
                    用修改后的文案
                </button>
                {/* 改了文案却点了「就这样」，改动就白费了。
                    与其禁用，不如明确提示哪个按钮才是他想要的 */}
                {changed ? (
                    <span className="text-ed-sm text-[#F0B860]">
                        文案有改动，记得点右边那个
                    </span>
                ) : null}
            </div>
        </section>
    );
}

export function MatchApproval({ run }: { run: UseAgentRun }) {
    const [rejected, setRejected] = useState<number[]>([]);

    useEffect(() => {
        setRejected([]);
    }, [run.matches]);

    const toggle = (index: number): void => {
        setRejected((prev) =>
            prev.includes(index)
                ? prev.filter((i) => i !== index)
                : [...prev, index]
        );
    };

    return (
        <section aria-label="确认素材" className="flex flex-col gap-4">
            <h3 className="text-[19px] font-bold text-ed-text">确认素材匹配</h3>
            <ul className="flex max-h-80 flex-col gap-2 overflow-y-auto scrollbar-ed">
                {run.matches.map((match, index) => (
                    <li
                        key={`${match.goal}-${index}`}
                        className="flex items-center justify-between rounded-xl border border-msg-border px-3.5 py-3"
                    >
                        <div className="flex min-w-0 flex-col gap-1">
                            <span className="text-ed-md text-ed-text">
                                分镜 {String(index + 1).padStart(2, '0')} ·{' '}
                                {match.goal}
                            </span>
                            <span className="truncate text-ed-sm text-ed-text-2">
                                {match.abandoned
                                    ? '没有配上素材，已跳过'
                                    : (match.assetName ?? '未选中')}
                            </span>
                        </div>
                        {match.abandoned ? null : (
                            <button
                                type="button"
                                aria-pressed={rejected.includes(index)}
                                onClick={() => toggle(index)}
                                className={`h-9 shrink-0 cursor-pointer rounded-lg border px-4 text-ed-sm ${
                                    rejected.includes(index)
                                        ? 'border-[#F06AB0] text-[#F06AB0]'
                                        : 'border-msg-border text-ed-text-2'
                                }`}
                            >
                                {rejected.includes(index)
                                    ? '已标记换一个'
                                    : '换一个'}
                            </button>
                        )}
                    </li>
                ))}
            </ul>
            <div className="flex items-center gap-3">
                <button
                    type="button"
                    onClick={() => void run.approveMatches()}
                    className="flex h-11 cursor-pointer items-center justify-center rounded-[10px] bg-linear-to-r from-[#F06AB0] to-[#8A5CFF] px-6 text-ed-md font-bold text-ed-text"
                >
                    就这样，继续
                </button>
                <button
                    type="button"
                    disabled={rejected.length === 0}
                    onClick={() => void run.approveMatches(rejected)}
                    className="flex h-11 cursor-pointer items-center justify-center rounded-[10px] border border-msg-border px-6 text-ed-md text-ed-text disabled:cursor-not-allowed disabled:opacity-40"
                >
                    重挑标记的 {rejected.length} 个
                </button>
            </div>
        </section>
    );
}
