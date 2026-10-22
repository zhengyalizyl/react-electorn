import type { ScenePreview } from '@/client/agent-ipc';

/**
 * 分镜列表（设计稿 W8bPLG 的「文稿结构摘要」那种卡中卡）。
 *
 * 稿子上那一块列的是文稿的时间段；我们的图产出的是**分镜**，
 * 同性质——都是"这条片子由哪几段组成"。所以沿用那个样式：
 * 标题一句 + 每段一个圆点加一行字。
 *
 * ⚠️ **这里不显示时间轴。** 分镜规划阶段还没合成配音，真实时长要等 TTS；
 * 编一个"0:00-0:25"出来是假数据，而它看起来恰恰最像真的。
 */
export default function SceneList({ scenes }: { scenes: ScenePreview[] }) {
    return (
        <section
            aria-label="分镜"
            className="flex w-full flex-col gap-2 rounded-[10px] border border-msg-border bg-msg-inset px-3.5 py-3"
        >
            <h3 className="text-ed-md font-bold text-msg-text">
                分镜与画面意图
            </h3>

            <ol className="flex flex-col gap-2">
                {scenes.map((scene, index) => (
                    <li
                        key={`${scene.goal}-${index}`}
                        className="flex w-full items-start gap-2"
                    >
                        <span
                            aria-hidden="true"
                            className="mt-1.5 size-1.5 shrink-0 rounded-full bg-msg-done"
                        />
                        <span className="flex min-w-0 flex-col gap-0.5">
                            <span className="text-ed-base text-msg-text-3">
                                {String(index + 1).padStart(2, '0')}{' '}
                                {scene.goal} · {scene.visualIntent}
                            </span>
                            <span className="text-ed-base text-msg-text-4">
                                {scene.script}
                            </span>
                        </span>
                    </li>
                ))}
            </ol>
        </section>
    );
}
