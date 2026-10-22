/**
 * 右侧的确认气泡（设计稿 W8bPLG 的「用户确认消息气泡」）。
 *
 * 用户在中断点点下的那一下，**要在记录里留下痕迹**。
 * 不留的话，滚回去只看得见一串助手消息，看不出是谁放的行、放的是哪一版。
 *
 * 带 `aria-label` 是为了让"这句话出现在气泡里"可以被精确断言。
 * 按纯文本找的话会撞上刚点过的那个按钮——两者文案本来就一样，
 * 而收起按钮与追加气泡之间有一帧两者并存，负载高的时候就会偶发地红。
 */
export default function UserBubble({ text }: { text: string }) {
    return (
        <div aria-label="我的回复" className="flex w-full justify-end">
            <p className="w-fit rounded-[14px] border border-msg-user-border bg-msg-user px-4 py-3 text-ed-lg font-semibold text-msg-user-text">
                {text}
            </p>
        </div>
    );
}
