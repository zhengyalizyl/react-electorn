import {
    ArrowUp,
    ChevronDown,
    ChevronUp,
    Image as ImageIcon,
    X
} from 'lucide-react';
import { useEffect, useState } from 'react';

import Card from '@/renderer/components/editor/Card';
import Chip from '@/renderer/components/editor/Chip';
import IconButton from '@/renderer/components/editor/IconButton';

/**
 * 快捷调整（配置区底部）。
 *
 * ## 同一个输入框，两种去处
 *
 * **胶囊还在**（要求针对某一镜）→ 真的把那一镜重做一遍：文案重写、
 * 口播重念、时间轴重排。
 *
 * **胶囊叉掉了**（针对整条片子）→ 仍然只是记进 `ai.requests`，
 * 因为"对整条片子重做"还没有这个能力。这种时候说的是"已记下"，
 * **绝不说"已修改"**——让人以为片子变了，比不给输入框更糟。
 *
 * 两种去处在界面上是分得出来的：真改的时候下面会报进度，记下的时候
 * 只有右上角那个计数会加一。
 *
 * ## 那枚胶囊跟着选中的分镜走
 *
 * 写死成「分镜 01」的话，用户选了第 2 镜、在这里提要求，改的却是第 1 镜，
 * 而他从界面上完全看不出来。
 */

interface ComposerProps {
    /** 当前选中的分镜，例如「分镜 02」。不传就不显示那枚胶囊 */
    sceneLabel?: string | undefined;
    /**
     * 提交一条要求。不传时输入框只读——没有去处的输入不如不给。
     *
     * `attachScene` 说的是**这条要求针对哪一镜**：胶囊还在就是当前这一镜，
     * 用户把它叉掉了就是针对整条片子。这个区别要传出去，
     * 否则叉掉胶囊只是让它从界面上消失，记下来的仍然挂在那一镜上。
     */
    onSubmit?:
        | ((text: string, attachScene: boolean) => Promise<void> | void)
        | undefined;
    /** 已经记下的条数，显示在标题右边 */
    recorded?: number | undefined;
    /**
     * 外面正在跑（改一镜）。和内部那个"提交中"取或。
     *
     * 两个状态都要有：内部那个管的是提交这一下，外面这个管的是
     * 改写 + 合成那十几秒——后者由页面持有，因为改完要换掉整份工程。
     */
    busy?: boolean | undefined;
    /** 当前在干什么。**改一镜要十几秒**，不说的话用户以为卡住了 */
    status?: string | null | undefined;
    /** 上一次改失败的原因 */
    error?: string | null | undefined;
}

export default function Composer({
    sceneLabel,
    onSubmit,
    recorded = 0,
    busy: external = false,
    status = null,
    error = null
}: ComposerProps) {
    const [text, setText] = useState('');
    const [busy, setBusy] = useState(false);
    const [collapsed, setCollapsed] = useState(false);
    /** 用户把那枚分镜胶囊叉掉了——这条要求是针对整条片子的 */
    const [detached, setDetached] = useState(false);

    /**
     * 换一镜就把胶囊装回来。
     *
     * 不重置的话，用户在第 1 镜叉掉胶囊、再去点第 3 镜，胶囊仍然不见——
     * 他会以为"这个编辑器就是不认分镜"，而其实只是上一次的操作还粘着。
     *
     * **只重置胶囊，不碰已经打了一半的字**：那是用户的东西。
     */
    useEffect(() => setDetached(false), [sceneLabel]);

    const running = busy || external;
    const canSend = onSubmit !== undefined && text.trim() !== '' && !running;
    const showChip = sceneLabel !== undefined && !detached;

    const send = async (): Promise<void> => {
        if (!canSend) return;
        setBusy(true);
        try {
            await onSubmit(text.trim(), showChip);
            setText('');
        } catch {
            /**
             * **失败就把字留着。**
             *
             * 清掉的话，用户那句斟酌过措辞的要求得重打一遍——而这一下
             * 本来就已经让他等了十几秒。失败的原因由上面那条 `error` 显示，
             * 这里只负责别把输入吃掉。
             */
        } finally {
            setBusy(false);
        }
    };

    return (
        <Card className="gap-3">
            <div className="flex w-full items-center justify-between">
                <span className="text-ed-base text-ed-text-2">快捷调整</span>
                <div className="flex items-center gap-2">
                    {recorded > 0 ? (
                        <span className="text-ed-sm text-ed-text-3">
                            已记下 {recorded} 条
                        </span>
                    ) : null}
                    <IconButton
                        icon={collapsed ? ChevronDown : ChevronUp}
                        label={collapsed ? '展开快捷调整' : '收起快捷调整'}
                        size={14}
                        onClick={() => setCollapsed((value) => !value)}
                        className="text-ed-text-2"
                    />
                </div>
            </div>

            {collapsed ? null : (
                <>
                    <textarea
                        aria-label="快捷调整输入"
                        value={text}
                        readOnly={onSubmit === undefined}
                        onChange={(event) => setText(event.target.value)}
                        onKeyDown={(event) => {
                            // Enter 直接发，Shift+Enter 换行——聊天框的通用手感
                            if (event.key === 'Enter' && !event.shiftKey) {
                                event.preventDefault();
                                void send();
                            }
                        }}
                        placeholder="输入你的任何想法"
                        className="min-h-[52px] w-full resize-none bg-transparent text-ed-base leading-ed text-ed-text caret-ed-text outline-none placeholder:text-ed-text-3"
                    />

                    <div className="flex w-full items-center justify-between">
                        {showChip ? (
                            <Chip className="flex items-center gap-1.5">
                                <ImageIcon
                                    size={12}
                                    className="text-ed-text-2"
                                />
                                <span className="text-ed-sm text-ed-text">
                                    {sceneLabel}
                                </span>
                                <IconButton
                                    icon={X}
                                    label={`移除${sceneLabel}`}
                                    size={11}
                                    onClick={() => setDetached(true)}
                                    className="text-ed-text-2"
                                />
                            </Chip>
                        ) : (
                            // 叉掉之后要说清楚这条要求现在是针对谁的，
                            // 留一片空白的话用户不知道刚才那一下到底做了什么
                            <span className="text-ed-sm text-ed-text-3">
                                {sceneLabel === undefined ? '' : '针对整条片子'}
                            </span>
                        )}
                        <IconButton
                            icon={ArrowUp}
                            label="发送"
                            size={14}
                            disabled={!canSend}
                            onClick={() => void send()}
                            className="flex size-7 items-center justify-center rounded-full border border-ed-border bg-ed-panel-2 text-ed-text disabled:cursor-not-allowed disabled:opacity-40"
                        />
                    </div>

                    {/* 改一镜要先调模型想词再合成，十几秒跑不掉。
                        只锁住按钮不说话的话，用户会以为是卡住了 */}
                    {status === null ? null : (
                        <span className="text-ed-sm text-ed-text-3">
                            {status}
                        </span>
                    )}

                    {error === null ? null : (
                        <span
                            role="alert"
                            className="text-ed-sm text-ed-accent"
                        >
                            {`改失败：${error}`}
                        </span>
                    )}
                </>
            )}
        </Card>
    );
}
