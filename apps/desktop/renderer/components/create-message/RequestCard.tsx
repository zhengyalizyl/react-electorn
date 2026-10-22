import { ChevronDown } from 'lucide-react';
import { useState } from 'react';

import { findVoice } from '@magicut-react-demo/video-agent/voices';

/**
 * 聊天记录的第一条：你的创作需求（设计稿 W8bPLG 的「用户创作需求消息卡」）。
 *
 * 卡里的东西**全是刚才真的提交过的**：文稿原文、两枚配置胶囊、选中的素材。
 * 稿子上那句「帮我生成一条 60 秒产品介绍短视频…」是画稿时的示意文案，
 * 照抄会让人以为系统收到的是那个。
 *
 * 头部那个箭头**能真的收起来**：文稿可能很长，翻历史时挡路。
 */

interface RequestCardProps {
    script: string;
    voiceId: string | null;
    /** 选中的素材文件名。空数组时不显示这一行 */
    materials: string[];
}

function Chip({ label, value }: { label: string; value: string }) {
    return (
        <span className="flex w-fit items-center overflow-hidden rounded-md bg-msg-chip">
            <span className="px-2.5 py-1.5 text-ed-base text-msg-chip-text">
                {label}
            </span>
            <span className="bg-msg-chip-value px-2.5 py-1.5 text-ed-base text-msg-chip-text">
                {value}
            </span>
        </span>
    );
}

export default function RequestCard({
    script,
    voiceId,
    materials
}: RequestCardProps) {
    const [open, setOpen] = useState(true);
    const voice = voiceId === null ? undefined : findVoice(voiceId);

    return (
        <section
            aria-label="创作需求"
            className="flex w-full flex-col gap-3.5 rounded-[14px] border border-msg-border bg-msg-card px-5 py-[18px] shadow-[0_18px_42px_#00000055]"
        >
            <div className="flex w-full items-center justify-between">
                <span className="flex items-center gap-2">
                    <span
                        aria-hidden="true"
                        className="size-6 rounded-full bg-linear-135 from-msg-blue to-msg-done"
                    />
                    <span className="text-ed-lg leading-[1.45] font-semibold text-msg-text">
                        你
                    </span>
                </span>

                <button
                    type="button"
                    aria-expanded={open}
                    aria-label={open ? '收起需求' : '展开需求'}
                    onClick={() => setOpen((prev) => !prev)}
                    className="cursor-pointer text-msg-text-4"
                >
                    <ChevronDown
                        size={18}
                        className={`transition-transform duration-200 ${
                            open ? '' : '-rotate-90'
                        }`}
                    />
                </button>
            </div>

            {open ? (
                <>
                    <p className="text-ed-lg leading-[1.5] whitespace-pre-line text-msg-text-2">
                        {script}
                    </p>

                    <div className="flex flex-col gap-2">
                        {/* 「智能匹配素材」是实情：素材由 AssetMatcher 从索引库里挑 */}
                        <Chip label="视频画面" value="智能匹配素材" />
                        {voice ? (
                            <Chip label="旁白配音" value={voice.name} />
                        ) : null}
                    </div>

                    {materials.length > 0 ? (
                        <p
                            title={materials.join('\n')}
                            className="truncate text-ed-base text-msg-text-4"
                        >
                            素材：{materials.join('、')}
                        </p>
                    ) : null}
                </>
            ) : null}
        </section>
    );
}
