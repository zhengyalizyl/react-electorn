import { SlidersHorizontal } from 'lucide-react';

import MusicCard from '@/renderer/components/editor/music/MusicCard';
import MusicTrackRow from '@/renderer/components/editor/music/MusicTrackRow';
import type { Track } from '@/renderer/data/music-fixtures';
import { ALL_GENRES, genres } from '@/renderer/data/music-fixtures';

interface RecommendCardProps {
    tracks: readonly Track[];
    activeGenre: string;
    onGenreChange: (genre: string) => void;
    selectedId: string | null;
    /** 正在用作背景音乐的那一首，列表靠它标「使用中」 */
    currentId: string | null;
    onSelect: (id: string) => void;
}

export default function RecommendCard({
    tracks,
    activeGenre,
    onGenreChange,
    selectedId,
    currentId,
    onSelect
}: RecommendCardProps) {
    return (
        <MusicCard className="min-h-[180px] flex-1 gap-2.5">
            <div className="flex w-full shrink-0 items-center justify-between">
                <h3 className="font-mu-title text-ed-lg font-extrabold text-mu-text">
                    推荐音乐
                </h3>
                {/* 筛选入口显示的就是当前分类：设计稿画的是「平静」那一态，
                    而不是一个独立于分类按钮的固定值。

                    分类按钮就在下面一排，所以这颗的作用是**清掉筛选**：
                    滚到列表深处时不用再找回那排标签。已经是「全部」时置灰，
                    一颗点下去什么也不会发生的按钮只会让人以为是坏的。 */}
                <button
                    type="button"
                    aria-label={`筛选：${activeGenre}`}
                    disabled={activeGenre === ALL_GENRES}
                    onClick={() => onGenreChange(ALL_GENRES)}
                    className="flex h-6 items-center gap-[5px] rounded-lg border border-mu-border-2 bg-mu-inset-2 px-2 enabled:cursor-pointer disabled:cursor-not-allowed disabled:opacity-50"
                >
                    <SlidersHorizontal size={12} className="text-mu-text-3" />
                    <span className="font-mu-body text-ed-xs font-bold text-mu-text-2">
                        {activeGenre}
                    </span>
                </button>
            </div>

            {/* 分类横向滚动。
                min-w-0 是关键：flex 子项的 min-width 默认是 auto，会被内容顶开，
                那样整排标签会把卡片连带面板撑宽，而不是自己出滚动条。
                每个标签 shrink-0，否则它们会被挤扁成一条而不是滚动。 */}
            <div className="flex w-full min-w-0 shrink-0 items-center gap-1.5 overflow-x-auto overflow-y-hidden scrollbar-ed">
                {genres.map((genre) => {
                    const active = genre === activeGenre;

                    return (
                        <button
                            key={genre}
                            type="button"
                            aria-pressed={active}
                            onClick={() => onGenreChange(genre)}
                            className={`flex h-7 shrink-0 cursor-pointer items-center justify-center rounded-lg border px-3 font-mu-title text-[11px] font-extrabold transition-colors duration-150 ${
                                active
                                    ? 'border-mu-accent bg-mu-accent/15 text-mu-accent'
                                    : 'border-mu-border bg-mu-inset text-mu-text-2'
                            }`}
                        >
                            {genre}
                        </button>
                    );
                })}
            </div>

            {tracks.length > 0 ? (
                <ul className="flex min-h-0 w-full flex-col gap-2 overflow-y-auto scrollbar-ed">
                    {tracks.map((track) => (
                        <MusicTrackRow
                            key={track.id}
                            track={track}
                            selected={track.id === selectedId}
                            inUse={track.id === currentId}
                            onSelect={onSelect}
                        />
                    ))}
                </ul>
            ) : (
                <p className="flex min-h-0 w-full flex-1 items-center justify-center font-mu-body text-ed-sm text-mu-text-3">
                    该分类下暂无曲目
                </p>
            )}
        </MusicCard>
    );
}
