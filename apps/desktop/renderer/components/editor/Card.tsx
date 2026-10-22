import type { ReactNode } from 'react';

interface CardProps {
    /** 列间距与 flex 行为由调用方决定，设计稿里每张卡不一样 */
    className?: string;
    children: ReactNode;
}

/**
 * 配置面板里的卡片容器。
 *
 * 圆角 12、描边 ed-border、底色 ed-panel、内边距 14 这四项在设计稿里是一套，
 * 共 7 处：字幕面板 2、音乐面板 3、画面面板的分段卡与输入框各 1。
 *
 * 注意口播面板的上传卡不是这一套（圆角 8、内边距 12），别往这里套。
 */
export default function Card({ className = '', children }: CardProps) {
    return (
        <div
            className={`flex w-full flex-col rounded-xl border border-ed-border bg-ed-panel p-3.5 ${className}`}
        >
            {children}
        </div>
    );
}
