import { House, Scissors, Upload } from 'lucide-react';

import { formatUpdatedAt } from '@/renderer/data/updated-at';

/** 设计稿 kqZiT 里写死的工程名，没有从项目页带 id 进来时用它 */
export const DEFAULT_PROJECT_TITLE = '口播短片自动剪辑工程';

/** 保存状态。设计稿只画了「已自动保存」那一态，另外两态是真跑起来才有的 */
export type SaveState = 'saved' | 'saving' | 'failed';

const SAVE_TEXT: Record<SaveState, string> = {
    saved: '已自动保存',
    saving: '正在保存…',
    failed: '保存失败'
};

interface EditorHeaderProps {
    title?: string | undefined;
    /**
     * 点左上角品牌区回首页。
     *
     * 收回调而不是在这里 useNavigate：EditorPage 刻意不依赖 Router，
     * 导航由路由层注入，组件测试才能脱离 RouterProvider 直接渲染。
     */
    onHome?: (() => void) | undefined;
    /** 工程的 `updatedAt`。拿不到就不说这句话，**不编一个时间** */
    updatedAt?: string | undefined;
    /** 存盘状态。不传时不显示——没在存东西就别声称"已保存" */
    saveState?: SaveState | undefined;
    /**
     * 渲染导出。
     *
     * 不传时按钮置灰并说明原因（浏览器里渲染不了，没有工程目录也没处写）。
     */
    onExport?: (() => void) | undefined;
    /** 正在渲染时的进度，0–1。没在渲染时是 null */
    exportRatio?: number | null | undefined;
    /**
     * 上一次导出的结果。
     *
     * 导出完**必须说一句**：文件写到哪儿了。不说的话用户点完按钮、
     * 等了两分钟、进度条消失，然后不知道片子在哪——只能去翻文件夹。
     */
    exportOutPath?: string | null | undefined;
    exportError?: string | null | undefined;
}

export default function EditorHeader({
    title = DEFAULT_PROJECT_TITLE,
    onHome,
    updatedAt,
    saveState,
    onExport,
    exportRatio,
    exportOutPath,
    exportError
}: EditorHeaderProps) {
    const exporting = exportRatio !== null && exportRatio !== undefined;
    const when = formatUpdatedAt(updatedAt);
    // 两截各自可能没有，拼之前先滤掉，免得出现孤零零一个「·」
    const status = [when, saveState ? SAVE_TEXT[saveState] : null]
        .filter(Boolean)
        .join(' · ');
    return (
        <header className="flex h-[88px] shrink-0 items-center justify-between border-b border-ed-border bg-ed-bg px-7">
            <button
                type="button"
                aria-label="返回首页"
                onClick={onHome}
                className="group flex w-[220px] cursor-pointer items-center gap-3 text-left"
            >
                {/* 悬停/聚焦时剪刀换成 house，纯 CSS 切换，不走 state 省一次重渲染 */}
                <span className="flex size-[34px] items-center justify-center rounded-lg bg-linear-135 from-[#FF5C7A] to-[#D62C4E] transition-transform duration-150 group-hover:scale-105 group-active:scale-95">
                    <Scissors
                        size={18}
                        className="text-white group-hover:hidden group-focus-visible:hidden"
                    />
                    <House
                        size={18}
                        className="hidden text-white group-hover:block group-focus-visible:block"
                    />
                </span>
                <span className="flex flex-col gap-0.5">
                    <span className="text-ed-xl font-bold text-ed-text">
                        妙剪 Magicut
                    </span>
                    <span className="text-ed-xs text-ed-text-2 transition-colors duration-150 group-hover:text-ed-text">
                        智能视频剪辑工具
                    </span>
                </span>
            </button>

            <div className="flex flex-col items-center gap-1">
                <h1 className="max-w-[560px] truncate text-ed-4xl font-bold text-ed-text">
                    {title}
                </h1>
                {/*
                    这一行一次只说一件事，按**紧急程度**排：
                    导出失败 > 刚导出成功 > 保存状态。
                    三样挤在一起只会让每一样都看不清。
                */}
                {exportError ? (
                    <span role="alert" className="text-ed-sm text-ed-accent">
                        {`导出失败：${exportError}`}
                    </span>
                ) : exportOutPath ? (
                    <span className="max-w-[560px] truncate text-ed-sm text-ed-text-2">
                        {`已导出到 ${exportOutPath}`}
                    </span>
                ) : status === '' ? null : (
                    <span
                        className={`text-ed-sm ${
                            saveState === 'failed'
                                ? 'text-ed-accent'
                                : 'text-ed-text-2'
                        }`}
                    >
                        {status}
                    </span>
                )}
            </div>

            <div className="flex w-[220px] items-center justify-end gap-3">
                {/*
                    渲染一条几分钟的片子要等很久，所以按钮本身就是进度条：
                    底色按百分比铺过去。转一个假圈的话，用户在第三十秒
                    就会开始怀疑是不是卡死了。
                */}
                <button
                    type="button"
                    disabled={onExport === undefined || exporting}
                    {...(onExport && !exporting ? { onClick: onExport } : {})}
                    // 置灰时说清楚为什么，光灰着一样让人猜
                    title={
                        onExport === undefined
                            ? '渲染导出只能在桌面端用'
                            : undefined
                    }
                    className="relative flex items-center gap-1.5 overflow-hidden rounded-lg bg-ed-accent px-3.5 py-2 enabled:cursor-pointer disabled:cursor-not-allowed disabled:opacity-40"
                >
                    {exporting ? (
                        <span
                            aria-hidden="true"
                            style={{
                                width: `${Math.round(exportRatio * 100)}%`
                            }}
                            className="absolute inset-y-0 left-0 bg-white/25"
                        />
                    ) : null}
                    <Upload size={14} className="relative text-white" />
                    <span className="relative text-ed-md font-bold text-white">
                        {exporting
                            ? `导出中 ${Math.round(exportRatio * 100)}%`
                            : '渲染导出'}
                    </span>
                </button>
            </div>
        </header>
    );
}
