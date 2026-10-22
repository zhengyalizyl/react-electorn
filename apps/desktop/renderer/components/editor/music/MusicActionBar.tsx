import { Music, Trash2 } from 'lucide-react';

interface MusicActionBarProps {
    /** 选中曲目的名称，用来给按钮拼可达名称 */
    trackName: string;
    /**
     * 总开关是否开启。关闭时两个按钮都置灰禁用——
     * 而不是整条隐藏：藏起来用户不知道为什么不能操作，禁用态能看出是开关的缘故。
     */
    enabled: boolean;
    onRemove: () => void;
    onApply: () => void;
}

export default function MusicActionBar({
    trackName,
    enabled,
    onRemove,
    onApply
}: MusicActionBarProps) {
    return (
        <div className="bar-rise flex w-full items-center gap-2.5">
            <button
                type="button"
                disabled={!enabled}
                onClick={onRemove}
                aria-label={`移除 ${trackName}`}
                className="flex h-[42px] w-[92px] shrink-0 cursor-pointer items-center justify-center gap-2 rounded-[10px] border border-mu-border bg-mu-inset transition-opacity duration-150 disabled:cursor-not-allowed disabled:opacity-40"
            >
                <Trash2 size={15} className="text-mu-text-2" />
                <span className="font-mu-title text-[13px] font-bold text-mu-text-2">
                    移除
                </span>
            </button>

            <button
                type="button"
                disabled={!enabled}
                onClick={onApply}
                aria-label={`应用此音乐：${trackName}`}
                className="flex h-[42px] flex-1 cursor-pointer items-center justify-center gap-2 rounded-[10px] bg-mu-accent transition-opacity duration-150 disabled:cursor-not-allowed disabled:opacity-40"
            >
                <Music size={15} className="text-white" />
                <span className="font-mu-title text-[13px] font-bold text-white">
                    应用此音乐
                </span>
            </button>
        </div>
    );
}
