import type { ButtonHTMLAttributes, ReactNode } from 'react';

/**
 * 分镜卡片的视图模型。
 *
 * 刻意**不是** VideoProject 的 `Scene`：卡片要的是格式化好的时间区间文本，
 * 而 Scene 上是毫秒。把格式化放进卡片会让它被迫认识时间线的概念。
 */
export interface ShotCardView {
    label: string;
    /** 已格式化的区间，形如 `00:04-00:08` */
    time: string;
    script: string;
    /**
     * 「为什么给这一镜选了这个素材」，来自 `ai.decisions`。
     *
     * plan.md §7.1 把留痕定成必须项：看到不合理结果时没有它就无从调试。
     * 示例工程没有决策记录，所以是可选的。
     */
    reason?: string | undefined;
}

// 共享内部件：只负责结构与不随状态变化的样式。
// 随状态变化的部分由各变体通过 className 传入，而不是在这里塞 isCurrent 分支。

type FrameProps = ButtonHTMLAttributes<HTMLButtonElement> & {
    children: ReactNode;
};

function ShotCardFrame({ className = '', children, ...rest }: FrameProps) {
    return (
        <button
            type="button"
            className={`flex w-full flex-col gap-2 rounded-lg px-3 pt-3 pb-3.5 text-left ${className}`}
            {...rest}
        >
            {children}
        </button>
    );
}

function ShotTopRow({ children }: { children: ReactNode }) {
    return (
        <div className="flex w-full items-center justify-between">
            {children}
        </div>
    );
}

function ShotLabelGroup({ children }: { children: ReactNode }) {
    return <div className="flex items-center gap-1.5">{children}</div>;
}

function ShotScript({
    className,
    children
}: {
    className: string;
    children: ReactNode;
}) {
    return (
        <p
            className={`w-full text-ed-md leading-ed whitespace-pre-line ${className}`}
        >
            {children}
        </p>
    );
}

/**
 * 选材理由。没有就整行不渲染——留一个空位比没有更碍眼。
 *
 * 用 `title` 挂全文：理由可能比较长，卡片里只给两行，
 * 悬停能看全，而不是把它截断了事。
 */
function ShotReason({ reason }: { reason?: string | undefined }) {
    if (!reason) return null;
    return (
        <p
            title={reason}
            className="line-clamp-2 w-full text-ed-xs leading-ed text-ed-text-3"
        >
            为什么选它：{reason}
        </p>
    );
}

// 两个显式变体。调用处一眼能看出渲染的是什么，没有布尔组合要推理。

export function IdleShotCard({
    shot,
    onSelect
}: {
    shot: ShotCardView;
    onSelect?: (() => void) | undefined;
}) {
    return (
        // 点哪一镜就切到哪一镜：**卡片本来就是 button**，
        // 之前只是没接 onClick，看着能点其实点了没反应
        <ShotCardFrame onClick={onSelect} className="cursor-pointer">
            <ShotTopRow>
                <ShotLabelGroup>
                    <span className="text-ed-sm text-ed-text-2">
                        {shot.label}
                    </span>
                </ShotLabelGroup>
                <span className="font-ed-mono text-ed-xs text-ed-text-3">
                    {shot.time}
                </span>
            </ShotTopRow>
            <ShotScript className="text-[#B8B8C0]">{shot.script}</ShotScript>
            <ShotReason reason={shot.reason} />
        </ShotCardFrame>
    );
}

export function CurrentShotCard({
    shot,
    onSelect
}: {
    shot: ShotCardView;
    onSelect?: (() => void) | undefined;
}) {
    return (
        <ShotCardFrame
            aria-current="true"
            onClick={onSelect}
            className="border border-ed-accent bg-ed-panel"
        >
            <ShotTopRow>
                <ShotLabelGroup>
                    <span className="text-ed-sm font-bold text-ed-text">
                        {shot.label}
                    </span>
                    <span className="text-ed-2xs text-ed-accent">当前</span>
                </ShotLabelGroup>
                <span className="font-ed-mono text-ed-xs font-bold text-ed-text">
                    {shot.time}
                </span>
            </ShotTopRow>
            <ShotScript className="font-bold text-ed-text">
                {shot.script}
            </ShotScript>
            <ShotReason reason={shot.reason} />
        </ShotCardFrame>
    );
}
