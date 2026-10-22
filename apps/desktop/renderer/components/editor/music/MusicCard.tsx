import type { ReactNode } from 'react';

interface MusicCardProps {
    className?: string;
    children: ReactNode;
}

/**
 * 音乐面板的卡片容器。
 *
 * 圆角 14、描边 mu-border、底色 mu-card、内边距 12/14 在设计稿里是一套，
 * 当前音乐 / 音量 / 推荐音乐三张卡共用。
 *
 * 和编辑器通用的 Card 不是一回事：那个是圆角 12 + ed-* 配色。
 */
export default function MusicCard({
    className = '',
    children
}: MusicCardProps) {
    return (
        <div
            className={`flex w-full flex-col rounded-[14px] border border-mu-border bg-mu-card px-3.5 py-3 ${className}`}
        >
            {children}
        </div>
    );
}
