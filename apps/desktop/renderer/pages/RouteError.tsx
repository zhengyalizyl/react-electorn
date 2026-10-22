import { useNavigate, useRouteError } from 'react-router-dom';

/**
 * 路由级兜底页。
 *
 * 没有它的话，渲染期抛错会直接露出 React Router 的开发态错误屏——
 * 桌面端既没有地址栏也没有刷新按钮，用户会卡死在那一屏出不来。
 *
 * 这里至少给一条回工作台的路，并把错误原文留在页面上方便排查。
 */
export default function RouteError() {
    const error = useRouteError();
    const navigate = useNavigate();

    const detail =
        error instanceof Error
            ? error.message
            : typeof error === 'string'
              ? error
              : JSON.stringify(error);

    return (
        <div className="flex h-full w-full flex-col items-center justify-center gap-6 bg-pj-bg font-ed">
            <h1 className="text-[28px] font-bold text-white">页面出了点问题</h1>
            <p className="max-w-[560px] text-center text-ed-md break-all text-pj-text-2">
                {detail}
            </p>
            <button
                type="button"
                onClick={() => navigate('/workspace', { replace: true })}
                className="cursor-pointer rounded-xl bg-pj-invert px-6 py-3 text-ed-lg font-bold text-pj-invert-text transition-opacity duration-150 hover:opacity-90"
            >
                返回工作台
            </button>
        </div>
    );
}
