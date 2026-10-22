import { Video } from 'lucide-react';

/**
 * 「创建新作品」卡。
 *
 * 设计稿的复合图标是两个叠放的圆角方块：橙色那个旋转 -15° 垫在后面，
 * 紫色那个正放在前面并装着 video 图标。用绝对定位 + rotate 还原。
 */
export default function NewProjectCard({ onCreate }: { onCreate: () => void }) {
    return (
        <div className="flex h-[288px] w-[353px] shrink-0 flex-col items-center justify-center gap-8 overflow-hidden rounded-[18px] border border-pj-card-border bg-pj-card p-5">
            <span
                aria-hidden="true"
                className="relative h-24 w-[110px] shrink-0"
            >
                <span className="absolute top-3.5 left-11 size-15 -rotate-15 rounded-[14px] bg-linear-135 from-[#F97A3C] to-[#FFC93C]" />
                <span className="absolute top-[26px] left-2 flex h-[66px] w-[78px] items-center justify-center rounded-2xl bg-[#7B5CC9]">
                    <Video size={28} className="text-white" />
                </span>
            </span>

            <button
                type="button"
                onClick={onCreate}
                className="flex h-[58px] w-full cursor-pointer items-center justify-center rounded-xl bg-pj-invert text-[19px] font-bold text-pj-invert-text transition-opacity duration-150 hover:opacity-90"
            >
                创建新作品
            </button>
        </div>
    );
}
