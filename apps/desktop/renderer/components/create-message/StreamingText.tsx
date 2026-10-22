/**
 * 模型正在写的那段（设计稿 W8bPLG 的助手正文，只是会动）。
 *
 * ## 显示的是内容，不是 JSON
 *
 * 流式拿到的其实是半截 JSON。`readableFromPartialJson` 已经把字段名、括号
 * 全剥掉，只留模型写出来的字——所以这里拿到的就是人话。
 *
 * ## 光标只表示"还在写"
 *
 * **没有任何伪造的进度**：写完了光标就停，文字留在记录里，
 * 因为那段文字正是这一步的产出摘要。
 */
export default function StreamingText({
    text,
    live
}: {
    text: string;
    live: boolean;
}) {
    return (
        <p className="w-full text-ed-lg leading-[1.6] whitespace-pre-line text-msg-text-3">
            {text}
            {live ? (
                <span
                    aria-label="正在生成"
                    className="ml-1 inline-block h-4 w-[2px] animate-pulse bg-msg-running align-middle motion-reduce:animate-none"
                />
            ) : null}
        </p>
    );
}
