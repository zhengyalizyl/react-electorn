import { AlertTriangle, FolderOpen, Loader2, X } from 'lucide-react';

import type { UseMediaLibrary } from '@/renderer/data/use-media-library';

/**
 * 素材选择（创作页操作行里的「选择素材」）。
 *
 * ## 点下去就是系统文件框，中间不隔任何东西
 *
 * 之前点开的是一个浮层，里面还要再点一次「选择视频」——多出来的那一层什么也没解决。
 * 现在一点就开系统对话框，在本地目录里直接挑 `.mp4`（可多选）；
 * macOS 上也可以整个目录一起选。
 *
 * **挑完直接建索引**：索引是本地操作（扫描 + ffprobe + 抽帧），只花 CPU 和磁盘，
 * 用户刚亲手挑完文件，再让他点一次"建立索引"纯属多余。
 *
 * ## 这里没有打标按钮（用户要求去掉）
 *
 * 打标要调模型、按量计费，界面上不给入口，也**绝不自动替用户跑**。
 * 需要的话走命令行：`pnpm --filter @magicut-react-demo/video-agent tag`。
 *
 * 代价是未打标的片段只能按文件名检索，匹配质量会差很多。
 * 这句提醒也按用户要求从状态行里去掉了——状态行只报"选了几项、切出几个片段"。
 */

/** 只显示文件名：完整路径又长又不好认 */
function baseName(value: string): string {
    const parts = value.split(/[\\/]/).filter(Boolean);
    return parts[parts.length - 1] ?? value;
}

/**
 * 按钮旁边那两行。
 *
 * **数字要对得上具体的文件**：只说"3 个片段"没法验证——用户看不出那 3 段是从哪
 * 几个文件里切出来的，也看不出库里是不是还混着上次索引的别的目录。
 * 所以第一行报合计，第二行逐个列出文件名与段数。
 */
function summaryLines(media: UseMediaLibrary): {
    head: string;
    files: string;
} | null {
    const status = media.status;
    if (!status || status.paths.length === 0) return null;

    if (status.missing.length > 0) {
        // 文件没了就直说，别显示一个看着正常的数字
        return {
            head: `${status.missing.length} 个文件已不存在`,
            files: status.missing.map(baseName).join('、')
        };
    }

    if (status.indexed.length === 0) {
        return {
            head: `已选 ${status.paths.length} 项，尚未建立索引`,
            files: status.paths.map(baseName).join('、')
        };
    }

    return {
        head: `${status.indexed.length} 个文件 · ${status.segments} 个片段`,
        files: status.indexed
            .map((file) => `${file.name}（${file.segments} 段）`)
            .join('、')
    };
}

export default function MediaPicker({ media }: { media: UseMediaLibrary }) {
    if (!media.available) {
        return (
            <span className="flex h-16 shrink-0 items-center rounded-[10px] border border-cr-card-border px-5 text-ed-md text-cr-placeholder">
                选择素材仅桌面端可用
            </span>
        );
    }

    const status = media.status;
    const busy = status?.busy ?? false;
    const progressLine = media.progress
        ? `${media.progress.job === 'index' ? '建立索引' : 'AI 打标'} ${
              media.progress.done
          }/${media.progress.total} · ${media.progress.label}`
        : null;
    const lines = summaryLines(media);

    return (
        <div className="flex min-w-0 items-center gap-3">
            <button
                type="button"
                disabled={busy}
                onClick={() => void media.pickAndIndex()}
                className="flex h-16 shrink-0 cursor-pointer items-center gap-2.5 rounded-[10px] border border-cr-card-border bg-cr-select px-5 text-[18px] font-bold text-white disabled:cursor-not-allowed disabled:opacity-40"
            >
                {busy ? (
                    <Loader2
                        size={18}
                        className="animate-spin text-[#8A5CFF] motion-reduce:animate-none"
                    />
                ) : (
                    <FolderOpen size={18} />
                )}
                选择素材
            </button>

            {/* 选错了要能一键回到"什么都没选"。
                重新选一次当然也能换掉，但"清空"是另一种意图，
                不给出口的话用户只能重启应用 */}
            {status && status.paths.length > 0 && !busy ? (
                <button
                    type="button"
                    aria-label="清空素材选择"
                    onClick={() => void media.clear()}
                    className="flex size-8 shrink-0 cursor-pointer items-center justify-center rounded-lg border border-cr-card-border text-cr-placeholder"
                >
                    <X size={14} />
                </button>
            ) : null}

            <div className="flex min-w-0 flex-col gap-0.5">
                {progressLine ? (
                    <span className="truncate text-ed-sm text-pj-text-2">
                        {progressLine}
                    </span>
                ) : lines ? (
                    <>
                        <span className="truncate text-ed-sm text-pj-text-2">
                            {lines.head}
                        </span>
                        {/* 文件名多起来一行放不下，悬停看全量；这一行只保证"看得见名字" */}
                        <span
                            title={lines.files}
                            className="truncate text-ed-sm text-cr-placeholder"
                        >
                            {lines.files}
                        </span>
                    </>
                ) : null}

                {/* 一个坏目录可能刷出几百条警告，只留最近一条 */}
                {media.warnings.length > 0 ? (
                    <span className="flex items-center gap-1.5 truncate text-ed-sm text-[#F0B860]">
                        <AlertTriangle size={14} className="shrink-0" />
                        {media.warnings[media.warnings.length - 1]}
                    </span>
                ) : null}

                {media.error ? (
                    <span className="truncate text-ed-sm text-[#FF6B7A]">
                        {media.error}
                    </span>
                ) : null}
            </div>
        </div>
    );
}
