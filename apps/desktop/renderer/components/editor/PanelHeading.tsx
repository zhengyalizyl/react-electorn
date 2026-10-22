import type { ReactNode } from 'react';

interface PanelHeadingProps {
    title: string;
    caption: string;
    /** 右侧插槽，字幕与音乐面板放的都是总开关 */
    children?: ReactNode;
}

/**
 * 面板级标题：主标题 + 一行说明，右侧可挂控件。
 *
 * 字幕与音乐面板共用这一套。口播面板的头部是另一种形态
 * （图标 + 16px 标题，说明文字另起一行、没有右侧控件），不走这里。
 */
export default function PanelHeading({
    title,
    caption,
    children
}: PanelHeadingProps) {
    return (
        <div className="flex w-full items-center justify-between">
            <div className="flex flex-col gap-[3px]">
                <h2 className="text-ed-3xl font-bold text-ed-text">{title}</h2>
                <p className="text-ed-sm text-ed-text-2">{caption}</p>
            </div>
            {children}
        </div>
    );
}
