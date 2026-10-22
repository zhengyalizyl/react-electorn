import { Sparkles } from 'lucide-react';

import MusicCard from '@/renderer/components/editor/music/MusicCard';
import type { CurrentTrack } from '@/renderer/data/music-fixtures';
import { currentCoverGradient } from '@/renderer/data/music-fixtures';

/** 当前生效的背景音乐。应用推荐列表里的曲子后由调用方换掉 track */
export default function CurrentMusicCard({ track }: { track: CurrentTrack }) {
    return (
        <MusicCard className="shrink-0 gap-2.5">
            <h3 className="font-mu-title text-[14px] font-extrabold text-mu-text">
                当前音乐
            </h3>

            <div className="flex w-full items-center gap-3">
                <span
                    aria-hidden="true"
                    className="flex size-14 shrink-0 items-center justify-center rounded-[10px]"
                    style={{ background: currentCoverGradient(track.cover) }}
                >
                    <Sparkles size={22} className="text-white" />
                </span>

                <div className="flex min-w-0 flex-col gap-[5px]">
                    <span className="truncate font-mu-title text-[17px] font-extrabold text-mu-text">
                        {track.name}
                    </span>
                    <span className="font-mu-body text-[11px] text-mu-text-2">
                        {track.credit}
                    </span>
                    <span className="font-mu-mono text-[10px] text-mu-text-3">
                        {track.detail}
                    </span>
                </div>
            </div>
        </MusicCard>
    );
}
