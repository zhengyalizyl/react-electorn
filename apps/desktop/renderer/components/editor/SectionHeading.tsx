import type { ReactNode } from 'react';

interface SectionHeadingProps {
    title: string;
    /**
     * 标题右侧的插槽。
     *
     * 设计稿里这一格有两种角色：说明文字（「已选 · 晓晨」「0 个音色」）和
     * 操作（「重置」）。收 ReactNode 而不是 string，调用方才能自己决定渲染成
     * 文字还是按钮。
     */
    children?: ReactNode;
}

/**
 * 面板内的小节标题行。
 *
 * 口播面板里出现 3 次（选择音色 / 自定义音色库 / 参数调整），
 * 字幕与音乐面板的设计稿里同样有这一行。
 */
export default function SectionHeading({
    title,
    children
}: SectionHeadingProps) {
    return (
        <div className="flex w-full items-center justify-between">
            <h3 className="text-ed-md font-bold text-ed-text">{title}</h3>
            {children}
        </div>
    );
}
