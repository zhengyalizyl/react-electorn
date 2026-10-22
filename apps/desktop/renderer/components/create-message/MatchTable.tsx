import type { MatchPreview } from '@/client/agent-ipc';

/**
 * 素材匹配表（设计稿 W8bPLG 的「成片需求文档表格」那种两列表格）。
 *
 * 稿子上那张表是「字段 / 完整需求说明」；我们这里是「分镜 / 配到的素材」——
 * 同一种版式：左列窄、定宽、加深，右列填满。
 *
 * **只给文件名不给完整路径**：路径会暴露用户的目录结构（plan.md §12）。
 * 主进程那头已经砍成 basename 了，这里再重复一遍是为了提醒改的人别加回去。
 */
export default function MatchTable({ matches }: { matches: MatchPreview[] }) {
    return (
        <section aria-label="素材匹配" className="flex w-full flex-col gap-2">
            <h3 className="text-ed-md font-bold text-msg-text">
                分镜与配到的素材
            </h3>

            <div className="flex w-full flex-col gap-px overflow-hidden rounded-lg border border-msg-table-border bg-msg-table-border shadow-[0_8px_20px_#00000033]">
                <div className="flex w-full gap-px">
                    <span className="flex w-[118px] shrink-0 items-center bg-msg-table-head px-2.5 py-1.5 font-ed-mono text-ed-xs font-bold text-msg-table-head-text">
                        分镜
                    </span>
                    <span className="flex flex-1 items-center bg-msg-table-head-2 px-3 py-1.5 font-ed-mono text-ed-xs font-bold text-msg-table-head-text">
                        配到的素材
                    </span>
                </div>

                {matches.map((match, index) => (
                    <div
                        key={`${match.goal}-${index}`}
                        className="flex w-full gap-px"
                    >
                        <span className="flex w-[118px] shrink-0 items-center bg-msg-table-key px-2.5 py-2 text-ed-base font-bold text-msg-text">
                            {String(index + 1).padStart(2, '0')} {match.goal}
                        </span>
                        <span
                            className={`flex flex-1 items-center px-3 py-2 text-ed-base ${
                                index % 2 === 0
                                    ? 'bg-msg-table-row'
                                    : 'bg-msg-table-row-2'
                            } ${
                                match.abandoned
                                    ? 'text-msg-running'
                                    : 'text-msg-table-text'
                            }`}
                        >
                            {/* 放弃的那镜要说清楚，不然用户以为它配上了 */}
                            {match.abandoned
                                ? '没有配上素材，已跳过'
                                : (match.assetName ?? '未选中')}
                        </span>
                    </div>
                ))}
            </div>
        </section>
    );
}
