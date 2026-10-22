import type { ReactNode } from 'react';

interface SliderProps {
    /**
     * 左侧标签。
     *
     * 收 ReactNode 而不是 string：三个面板的标签样式不一样——口播是常规字重的
     * ed-text-2，字幕是加粗的 ed-text，音乐还在前面多一个音量图标。
     */
    label: ReactNode;
    /** 右侧读数，设计稿统一用等宽字体 */
    value: string;
    /** 填充百分比，与容器宽度解耦 */
    percent: number;
    /**
     * 可达名称。
     *
     * `label` 收的是 ReactNode（三个面板的标签样式不一样），拿不来当名字用，
     * 所以可拖动时要单独给一个——没有名字的滑杆在读屏里只会念「滑块」。
     */
    name?: string;
    /**
     * 给了就能拖，不给仍是只读的展示条。
     *
     * 同一个外观有两种用法：有去处的（口播音量、语速、字幕字号）和纯展示的。
     * **画成能拖却拖不动比画成静态更糟**，所以可不可动由调用方说了算——
     * 它才知道这一条背后有没有接上东西。
     */
    onPercentChange?: (next: number) => void;
}

/**
 * 读数行 + 轨道。
 *
 * 设计稿里同一套结构出现在口播的音量/语速、字幕的字号、音乐的音量上，
 * 所以按百分比收参数，而不是照抄设计稿那几个像素宽度
 * （面板里是 291，卡片里因为还有 14 的内边距是 263）。
 *
 * ## 为什么拖动交给原生 input[type=range]
 *
 * 自己监听 pointer 事件画一个，要补的是键盘（←/→/Home/End）、读屏角色、
 * 触摸、以及拖到容器外面还要继续跟手——每一条漏掉都是真实的不可用。
 * 原生控件这些全都有，所以它铺在轨道上层、透明，
 * **看到的是设计稿那条，摸到的是原生那条**。时间线的缩放滑杆也是这么做的。
 */
export default function Slider({
    label,
    value,
    percent,
    name,
    onPercentChange
}: SliderProps) {
    return (
        <div className="flex w-full flex-col gap-2">
            <div className="flex w-full items-center justify-between">
                {label}
                <span className="font-ed-mono text-ed-base text-ed-text">
                    {value}
                </span>
            </div>

            <div className="relative h-3 w-full">
                <span className="absolute top-1 left-0 h-1 w-full rounded-sm bg-ed-panel-2" />
                <span
                    className="absolute top-1 left-0 h-1 rounded-sm bg-ed-accent"
                    style={{ width: `${percent}%` }}
                />
                {/* 手柄宽 12，居中对齐填充末端 */}
                <span
                    className="absolute top-0 size-3 rounded-full bg-white"
                    style={{ left: `calc(${percent}% - 6px)` }}
                />
                {onPercentChange ? (
                    <input
                        type="range"
                        aria-label={name}
                        min={0}
                        max={100}
                        step={1}
                        value={percent}
                        onChange={(event) =>
                            onPercentChange(Number(event.target.value))
                        }
                        className="absolute inset-0 m-0 w-full cursor-pointer appearance-none bg-transparent p-0 opacity-0"
                    />
                ) : null}
            </div>
        </div>
    );
}
