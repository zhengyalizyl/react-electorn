import type { AiDecision, AiNote } from '@magicut-react-demo/video-project';

import { labelOfNode } from '@/renderer/data/node-labels';

/**
 * 智能体的创作过程（画面模式配置区）。
 *
 * ## 只显示这条片子自己的东西
 *
 * 设计稿上那几段（「我来分析你的文稿，这是一份关于"前端AI进阶学习路线"的教学内容…」）
 * 是画稿时编的示意文字。**照着显示等于让系统假装分析过一份它没见过的文稿**——
 * 用户看到的时间轴、主题全都对不上自己的片子。所以这里一条都不用。
 *
 * 按手上有什么显示什么：
 *
 * 1. `ai.notes`——创作时那几份流式报告，跟着工程落盘，最贴近"它当时怎么想的"
 * 2. 没有 notes 的老工程还有 `ai.decisions`——每一镜为什么选那个素材，同样是真话
 * 3. 两样都没有就直说没有记录，而不是找一段话填上
 */

interface AiMessageProps {
    notes?: AiNote[] | undefined;
    decisions?: AiDecision[] | undefined;
}

const SHELL =
    'flex min-h-[120px] w-full flex-1 flex-col gap-3 overflow-y-auto scrollbar-ed';

export default function AiMessage({ notes, decisions }: AiMessageProps) {
    if (notes && notes.length > 0) {
        return (
            <div aria-label="创作过程" className={SHELL}>
                {notes.map((note) => (
                    <div key={note.node} className="flex flex-col gap-1">
                        <span className="text-ed-sm font-bold text-ed-text-2">
                            {labelOfNode(note.node)}
                        </span>
                        <p className="w-full text-ed-md leading-ed whitespace-pre-line text-ed-text-2">
                            {note.text}
                        </p>
                    </div>
                ))}
            </div>
        );
    }

    // 老工程没有 notes，但有逐镜的选材理由——那也是它当时真写下的
    const reasons = (decisions ?? []).filter((item) => item.reason !== '');
    if (reasons.length > 0) {
        return (
            <div aria-label="创作过程" className={SHELL}>
                <span className="text-ed-sm font-bold text-ed-text-2">
                    选材理由
                </span>
                {reasons.map((decision, index) => (
                    <p
                        key={`${decision.sceneId ?? index}`}
                        className="w-full text-ed-md leading-ed text-ed-text-2"
                    >
                        {decision.sceneId
                            ? `${decision.sceneId}：${decision.reason}`
                            : decision.reason}
                    </p>
                ))}
            </div>
        );
    }

    return (
        <div aria-label="创作过程" className={SHELL}>
            <p className="text-ed-md leading-ed text-ed-text-3">
                这条片子没有留下创作过程记录。
            </p>
        </div>
    );
}
