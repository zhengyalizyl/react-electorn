import type { StageStatus, StageView } from '@/renderer/data/run-stages';
import { STATUS_TEXT } from '@/renderer/data/run-stages';

/**
 * 对话流里的四个阶段（设计稿 frame OrZJP 的 Steps）。
 *
 * 一行 = 圆点 + 标题/说明 + 右侧状态，行距 12。
 * 状态与圆点的颜色都由**智能体的真实进度**决定，见 `run-stages.ts`。
 */

/** 设计稿：进行中是琥珀，未开始是 ed-text-3，完成是绿 */
const DOT: Record<StageStatus, string> = {
    pending: 'bg-ed-text-3',
    running: 'bg-msg-running',
    waiting: 'bg-msg-running',
    done: 'bg-msg-done',
    failed: 'bg-ed-accent'
};

const STATUS_TONE: Record<StageStatus, string> = {
    pending: 'text-ed-text-2',
    running: 'text-msg-running',
    waiting: 'text-msg-running',
    done: 'text-msg-done',
    failed: 'text-ed-accent'
};

export default function StageSteps({ stages }: { stages: StageView[] }) {
    return (
        <ol aria-label="创作阶段" className="flex w-full flex-col gap-3">
            {stages.map((stage) => (
                <li
                    key={stage.id}
                    aria-current={
                        stage.status === 'running' || stage.status === 'waiting'
                            ? 'step'
                            : undefined
                    }
                    className="flex w-full items-center justify-between gap-4"
                >
                    <span className="flex items-center gap-3">
                        <span
                            aria-hidden="true"
                            className={`size-2 shrink-0 rounded-full ${DOT[stage.status]}`}
                        />
                        <span className="flex flex-col gap-1">
                            <span className="text-ed-lg font-bold text-ed-text">
                                {stage.ordinal} {stage.label}
                            </span>
                            <span className="text-ed-base text-ed-text-2">
                                {stage.desc}
                            </span>
                        </span>
                    </span>

                    <span
                        className={`shrink-0 text-ed-base ${STATUS_TONE[stage.status]}`}
                    >
                        {STATUS_TEXT[stage.status]}
                    </span>
                </li>
            ))}
        </ol>
    );
}
