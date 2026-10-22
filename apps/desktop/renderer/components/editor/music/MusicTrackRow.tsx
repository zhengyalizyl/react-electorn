import { Check, Music2 } from 'lucide-react';

import type { Track } from '@/renderer/data/music-fixtures';
import { coverGradient } from '@/renderer/data/music-fixtures';

interface MusicTrackRowProps {
    track: Track;
    /** 被点选中：底部操作条针对的是它 */
    selected: boolean;
    /** 正在用作背景音乐：与选中无关，可以同时成立 */
    inUse: boolean;
    onSelect: (id: string) => void;
}

/**
 * 推荐曲库的一行。
 *
 * 选中态与未选中态差四处：底色、描边、封面图标（music-2 → check）、
 * 风格徽标的底色与字色。差异集中且成对，用一个 selected 判断比拆两个组件更好读——
 * 和 ShotCard 的处理不同，那里两态的结构差得更多。
 *
 * 「使用中」徽标取自 m9jWt 那张稿，标的是当前正在用的背景音乐。
 */
export default function MusicTrackRow({
    track,
    selected,
    inUse,
    onSelect
}: MusicTrackRowProps) {
    return (
        <li>
            <button
                type="button"
                // 不给 aria-label 的话，可达名称会是行内全部文字拼成的一长串
                // （名称 + 时长 + 副信息 + 风格），读屏啰嗦，测试也难定位
                aria-label={track.name}
                aria-pressed={selected}
                onClick={() => onSelect(track.id)}
                className={`flex h-[54px] w-full cursor-pointer items-center gap-2.5 rounded-[10px] border px-2.5 text-left transition-colors duration-150 ${
                    selected
                        ? 'border-mu-accent bg-mu-accent/15'
                        : 'border-mu-border bg-mu-inset'
                }`}
            >
                <span
                    aria-hidden="true"
                    className="flex size-[34px] shrink-0 items-center justify-center rounded-[7px]"
                    style={{ background: coverGradient(track.cover) }}
                >
                    {selected ? (
                        <Check size={15} className="text-white" />
                    ) : (
                        <Music2 size={15} className="text-white" />
                    )}
                </span>

                <span className="flex min-w-0 flex-1 flex-col gap-1">
                    <span className="flex w-full items-center justify-between gap-[7px]">
                        <span className="flex min-w-0 items-center gap-1.5">
                            <span className="truncate font-mu-title text-[12.5px] font-extrabold text-mu-text">
                                {track.name}
                            </span>
                            {inUse ? (
                                <span className="shrink-0 rounded bg-mu-chip px-[5px] py-px font-mu-body text-[9px] text-mu-text-2">
                                    使用中
                                </span>
                            ) : null}
                        </span>
                        <span className="shrink-0 font-mu-mono text-[10px] font-bold text-mu-text-3">
                            {track.duration}
                        </span>
                    </span>

                    <span className="flex w-full items-center gap-[7px]">
                        <span className="truncate font-mu-body text-[10px] text-mu-text-3">
                            {track.credit}
                        </span>
                        <span
                            className={`flex h-[18px] shrink-0 items-center rounded-full px-[7px] font-mu-body text-[9.5px] font-bold ${
                                selected
                                    ? 'bg-mu-accent/20 text-mu-accent'
                                    : 'bg-mu-chip text-mu-text-2'
                            }`}
                        >
                            {track.style}
                        </span>
                    </span>
                </span>
            </button>
        </li>
    );
}
