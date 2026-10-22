/**
 * 成片需求文档（设计稿 W8bPLG 的「成片需求文档表格」）。
 *
 * 左列窄、定宽、加深，右列填满——和素材匹配表同一种版式。
 *
 * 表里每一行都是**前面几步的真实产出拼出来的**：主题/受众/基调来自文稿分析，
 * 素材那行来自库画像，音色来自配置。稿子上那些「配色 Carbon Frost」
 * 「字体 Inter」我们根本没有这些概念，不编。
 */
export default function RequirementTable({
    rows
}: {
    rows: { field: string; detail: string }[];
}) {
    return (
        <section
            aria-label="成片需求文档"
            className="flex w-full flex-col gap-2"
        >
            <h3 className="text-ed-md font-bold text-msg-text">成片需求文档</h3>

            <div className="flex w-full flex-col gap-px overflow-hidden rounded-lg border border-msg-table-border bg-msg-table-border shadow-[0_8px_20px_#00000033]">
                <div className="flex w-full gap-px">
                    <span className="flex w-[118px] shrink-0 items-center bg-msg-table-head px-2.5 py-1.5 font-ed-mono text-ed-xs font-bold text-msg-table-head-text">
                        字段
                    </span>
                    <span className="flex flex-1 items-center bg-msg-table-head-2 px-3 py-1.5 font-ed-mono text-ed-xs font-bold text-msg-table-head-text">
                        完整需求说明
                    </span>
                </div>

                {rows.map((row, index) => (
                    <div key={row.field} className="flex w-full gap-px">
                        <span className="flex w-[118px] shrink-0 items-center bg-msg-table-key px-2.5 py-2 text-ed-base font-bold text-msg-text">
                            {row.field}
                        </span>
                        <span
                            className={`flex flex-1 items-center px-3 py-2 text-ed-base text-msg-table-text ${
                                index % 2 === 0
                                    ? 'bg-msg-table-row'
                                    : 'bg-msg-table-row-2'
                            }`}
                        >
                            {row.detail}
                        </span>
                    </div>
                ))}
            </div>
        </section>
    );
}
