import type { StageStatus, StageView } from '@/renderer/data/run-stages';
import { STATUS_TEXT } from '@/renderer/data/run-stages';

/**
 * 右侧「执行目录」卡（设计稿 frame OrZJP 的 erSsy）。
 *
 * 和对话流里的阶段列表是**同一份数据的两种呈现**：对话流会随消息往下滚，
 * 这张卡钉在右上角，随时能看到"现在走到第几步"。
 */

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

export default function OutlineCard({ stages }: { stages: StageView[] }) {
    return (
        <aside
            aria-label="执行目录"
            // self-start：卡片高度由内容决定（设计稿 240x306），
            // 不写的话 flex 默认 stretch，会拉成一条到底的长条
            className="flex w-60 shrink-0 flex-col gap-5 self-start rounded-[14px] border border-msg-border bg-msg-card px-3.5 pt-4 pb-5"
        >
            <div className="flex flex-col gap-1">
                <h2 className="text-ed-lg font-bold text-ed-text">执行目录</h2>
                <p className="text-ed-sm text-ed-text-2">实时跟踪智能体阶段</p>
            </div>

            <ol className="flex w-full flex-col gap-[18px]">
                {stages.map((stage) => (
                    <li key={stage.id} className="flex w-full gap-2.5">
                        {/* 圆点要对齐第一行文字的视觉中线，所以单独包一层压 5px */}
                        <span className="pt-[5px]">
                            <span
                                aria-hidden="true"
                                className={`block size-1.5 rounded-full ${DOT[stage.status]}`}
                            />
                        </span>

                        <span className="flex min-w-0 flex-1 flex-col gap-1">
                            <span className="flex items-center justify-between gap-2">
                                <span className="text-ed-md font-bold text-ed-text">
                                    {stage.ordinal} {stage.label}
                                </span>
                                <span
                                    className={`shrink-0 text-ed-xs ${STATUS_TONE[stage.status]}`}
                                >
                                    {STATUS_TEXT[stage.status]}
                                </span>
                            </span>
                            <span className="text-ed-sm text-ed-text-2">
                                {stage.desc}
                            </span>
                        </span>
                    </li>
                ))}
            </ol>
        </aside>
    );
}
