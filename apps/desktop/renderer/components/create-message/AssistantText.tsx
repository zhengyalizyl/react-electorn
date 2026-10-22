import { AlertTriangle } from 'lucide-react';

/**
 * 助手的一句话（设计稿 W8bPLG 里那几段正文）。
 *
 * 内容来自图真报上来的 `decision` / `warning`，**不编对白**——
 * 稿子上那些「我来分析你的文稿…」是画稿时写的示意句。
 */
export default function AssistantText({
    text,
    tone
}: {
    text: string;
    tone: 'normal' | 'warning';
}) {
    if (tone === 'warning') {
        return (
            <p className="flex w-full items-start gap-2 text-ed-lg leading-[1.6] text-msg-running">
                <AlertTriangle size={16} className="mt-1 shrink-0" />
                {text}
            </p>
        );
    }

    return (
        <p className="w-full text-ed-lg leading-[1.6] text-msg-text-2">
            {text}
        </p>
    );
}
