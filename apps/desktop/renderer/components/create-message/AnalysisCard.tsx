/**
 * 文稿分析（设计稿 W8bPLG 的「文稿结构摘要」那种卡中卡）。
 *
 * ## 为什么要单独摊开，而不是攒进需求文档
 *
 * 这是**第一处能看出"它读懂了没有"的地方**：把一句需求当成口播稿、
 * 主题跑偏、受众认错，往后每一步都基于它，错得越晚越贵。
 *
 * 卡里每个字都来自模型对**你这次输入**的分析：文稿结构是从原文读出来的，
 * 素材匹配度是对着库里的标签说的。
 */

interface AnalysisCardProps {
    inputKind: string;
    outline: string[];
    theme: string;
    audience: string;
    tone: string;
    keyPoints: string[];
    materialFit: string;
}

function Row({ label, value }: { label: string; value: string }) {
    return (
        <p className="flex gap-2 text-ed-base">
            <span className="shrink-0 text-msg-text-4">{label}</span>
            <span className="text-msg-text-3">{value}</span>
        </p>
    );
}

/** 带圆点的一条。设计稿里文稿结构就是这么排的 */
function Bullet({ text }: { text: string }) {
    return (
        <li className="flex items-start gap-2">
            <span
                aria-hidden="true"
                className="mt-1.5 size-1.5 shrink-0 rounded-full bg-msg-done"
            />
            <span className="text-ed-base text-msg-text-3">{text}</span>
        </li>
    );
}

export default function AnalysisCard({
    inputKind,
    outline,
    theme,
    audience,
    tone,
    keyPoints,
    materialFit
}: AnalysisCardProps) {
    return (
        <section
            aria-label="文稿分析"
            className="flex w-full flex-col gap-2.5 rounded-[10px] border border-msg-border bg-msg-inset px-3.5 py-3"
        >
            <h3 className="text-ed-md font-bold text-msg-text">{theme}</h3>

            <div className="flex flex-col gap-1">
                <Row label="输入类型" value={inputKind} />
                <Row label="目标观众" value={audience} />
                <Row label="基调" value={tone} />
                <Row label="素材匹配" value={materialFit} />
            </div>

            {outline.length > 0 ? (
                <div className="flex flex-col gap-1">
                    <p className="text-ed-base text-msg-text-4">文稿结构</p>
                    <ul className="flex flex-col gap-1">
                        {outline.map((item) => (
                            <Bullet key={item} text={item} />
                        ))}
                    </ul>
                </div>
            ) : null}

            {keyPoints.length > 0 ? (
                <div className="flex flex-col gap-1">
                    <p className="text-ed-base text-msg-text-4">内容要点</p>
                    <ul className="flex flex-col gap-1">
                        {keyPoints.map((item) => (
                            <Bullet key={item} text={item} />
                        ))}
                    </ul>
                </div>
            ) : null}
        </section>
    );
}
