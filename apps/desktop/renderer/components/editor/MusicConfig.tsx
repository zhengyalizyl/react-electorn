import { useState } from 'react';

import CurrentMusicCard from '@/renderer/components/editor/music/CurrentMusicCard';
import MusicActionBar from '@/renderer/components/editor/music/MusicActionBar';
import MusicVolumeCard from '@/renderer/components/editor/music/MusicVolumeCard';
import RecommendCard from '@/renderer/components/editor/music/RecommendCard';
import PinnedFooterShell from '@/renderer/components/editor/PinnedFooterShell';
import SwitchField from '@/renderer/components/editor/SwitchField';
import type { CurrentTrack } from '@/renderer/data/music-fixtures';
import {
    ACTIVE_GENRE,
    currentTrack,
    toCurrentTrack,
    tracks
} from '@/renderer/data/music-fixtures';

function MusicHeader({
    enabled,
    onToggle
}: {
    enabled: boolean;
    onToggle: (next: boolean) => void;
}) {
    return (
        <div className="flex w-full items-center justify-between">
            <div className="flex flex-col gap-[5px]">
                <h2 className="font-mu-title text-[20px] font-extrabold text-mu-text">
                    音乐设置
                </h2>
                <p className="font-mu-body text-[11px] text-mu-text-3">
                    控制背景音乐与推荐曲库
                </p>
            </div>
            <SwitchField
                label="开启"
                switchLabel="开启背景音乐"
                checked={enabled}
                onChange={onToggle}
                labelClassName="font-mu-body text-[11px] font-bold text-mu-text"
                switchClassName="bg-mu-accent"
            />
        </div>
    );
}

/**
 * 音乐模式的配置区。
 *
 * 对应 magicut-demo.pen 的 frame C1Sck（右侧音乐设置区）——**不是**
 * 「音乐-画面」里的那块。C1Sck 是一张独立探索稿，自带 mu-* 那套配色与
 * Inter / Geist 字体，并且多了底部操作条与筛选入口。
 *
 * 交互（设计稿是静态的，只画了 Eutopia 选中的那一帧）：
 * - 点分类按钮筛选曲库，风格取 style 的前半段
 * - 点某首曲子选中它，底部滑出「移除 / 应用此音乐」
 * - 应用后这首成为当前音乐，选中态清空
 * - 两个按钮都受顶部总开关控制，关掉即置灰禁用
 */
export default function MusicConfig() {
    // 初始不选中，这样「点一下曲目，底部条滑出来」这个过程能被看到。
    // 设计稿画的是已选中 Eutopia 的静态帧，要对齐那一帧就把初值改成 tracks[0].id。
    const [selectedId, setSelectedId] = useState<string | null>(null);
    const [enabled, setEnabled] = useState(true);
    const [genre, setGenre] = useState<string>(ACTIVE_GENRE);
    const [current, setCurrent] = useState<CurrentTrack>(currentTrack);

    // 「全部」不过滤；其余按 style 的前半段（风格）匹配，
    // style 形如「平静 · 偏慢」，后半是节奏不参与筛选
    const visibleTracks =
        genre === '全部'
            ? tracks
            : tracks.filter((track) => track.style.startsWith(genre));

    const selected = visibleTracks.find((track) => track.id === selectedId);

    const changeGenre = (next: string) => {
        setGenre(next);
        // 选中的曲子被筛掉后，底部操作条会指向一首看不见的曲子，先清掉
        setSelectedId(null);
    };

    const applySelected = () => {
        if (!selected) {
            return;
        }

        setCurrent(toCurrentTrack(selected));
        setSelectedId(null);
    };

    return (
        <PinnedFooterShell
            label="音乐"
            className="border-mu-border-2 bg-mu-bg"
            header={<MusicHeader enabled={enabled} onToggle={setEnabled} />}
            footer={
                selected ? (
                    <MusicActionBar
                        trackName={selected.name}
                        enabled={enabled}
                        onRemove={() => setSelectedId(null)}
                        onApply={applySelected}
                    />
                ) : null
            }
        >
            <CurrentMusicCard track={current} />
            <MusicVolumeCard />
            <RecommendCard
                tracks={visibleTracks}
                activeGenre={genre}
                onGenreChange={changeGenre}
                selectedId={selectedId}
                currentId={current.id}
                onSelect={setSelectedId}
            />
        </PinnedFooterShell>
    );
}
