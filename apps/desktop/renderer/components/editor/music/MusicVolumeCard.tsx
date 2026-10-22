import { Volume2 } from 'lucide-react';

import MusicCard from '@/renderer/components/editor/music/MusicCard';
import { VOLUME_VALUE, volumePercent } from '@/renderer/data/music-fixtures';

export default function MusicVolumeCard() {
    return (
        <MusicCard className="shrink-0 gap-3">
            <div className="flex w-full items-center justify-between">
                <h3 className="flex items-center gap-2 font-mu-title text-[14px] font-extrabold text-mu-text">
                    <Volume2 size={16} className="text-mu-text-2" />
                    音乐音量
                </h3>
                <span className="font-mu-mono text-[12px] font-bold text-mu-text">
                    {VOLUME_VALUE}
                </span>
            </div>

            <div className="relative h-[18px] w-full">
                <span className="absolute top-1.5 left-0 h-1.5 w-full rounded-full bg-mu-border" />
                <span
                    className="absolute top-1.5 left-0 h-1.5 rounded-full bg-mu-accent"
                    style={{ width: `${volumePercent}%` }}
                />
                {/* 手柄 18px，3px 描边在进度条上抠出一圈底色；居中对齐填充末端 */}
                <span
                    className="absolute top-0 size-[18px] rounded-full border-[3px] border-mu-knob-ring bg-white"
                    style={{ left: `calc(${volumePercent}% - 9px)` }}
                />
            </div>
        </MusicCard>
    );
}
