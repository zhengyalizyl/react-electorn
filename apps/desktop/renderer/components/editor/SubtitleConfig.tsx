import Card from '@/renderer/components/editor/Card';
import type { ConfigImplementationProps } from '@/renderer/components/editor/ConfigPanel';
import PanelHeading from '@/renderer/components/editor/PanelHeading';
import PanelShell from '@/renderer/components/editor/PanelShell';
import SectionHeading from '@/renderer/components/editor/SectionHeading';
import Slider from '@/renderer/components/editor/Slider';
import SwitchField from '@/renderer/components/editor/SwitchField';
import {
    APPLY_HINT,
    fontSizeLabel,
    fontSizeToPercent,
    percentToFontSize,
    styleSwatches,
    swatchById
} from '@/renderer/data/subtitle-fixtures';
import { settingsFromProject } from '@/renderer/data/subtitle-style';

/**
 * 字幕模式的配置区。
 *
 * 对应 magicut-demo.pen 的 frame DJZgj（妙剪 Magicut — 字幕-画面）
 * 里的 Right Panel — 配置区（lr2Fs）。
 *
 * ## 设置在页面手里，不在这儿
 *
 * 设计稿是静态的一帧，照着把 `state` 渲染出来的话，色卡看着能点、点了什么也
 * 不会发生。但光把它提成本组件的 state 还不够——
 *
 * 1. 预览要按同一份设置渲染字幕，存在这里它拿不到；
 * 2. 这个组件挂着 `key={tab}`（见 ConfigPanel），切去别的面板再切回来会整个
 *    重挂载，**存在自己身上的设置一来一回就没了**。
 *
 * 所以它是受控的：页面持有，这里只显示与回报。
 */
export default function SubtitleConfig({
    project,
    subtitle,
    onSubtitleChange,
    subtitleSaveError
}: ConfigImplementationProps) {
    // 没人传设置时按工程算一份出来，面板照样显示得对——
    // 但改不动：没有去处的输入不如不给
    const settings = subtitle ?? settingsFromProject(project);
    const selected = swatchById(settings.swatchId);
    const sizePercent = fontSizeToPercent(settings.fontSizePx);

    return (
        <PanelShell label="字幕">
            <PanelHeading title="字幕设置" caption="调整当前字幕轨显示样式">
                <SwitchField
                    label="显示字幕"
                    switchLabel="显示字幕"
                    checked={settings.visible}
                    onChange={(next) =>
                        onSubtitleChange?.(
                            { ...settings, visible: next },
                            'subtitle.visible'
                        )
                    }
                />
            </PanelHeading>

            <Card className="gap-2.5">
                <Slider
                    label={
                        <span className="text-ed-base font-bold text-ed-text">
                            字号
                        </span>
                    }
                    name="字号"
                    value={fontSizeLabel(sizePercent)}
                    percent={sizePercent}
                    {...(onSubtitleChange
                        ? {
                              onPercentChange: (next: number) =>
                                  onSubtitleChange(
                                      {
                                          ...settings,
                                          fontSizePx: percentToFontSize(next)
                                      },
                                      // 整段拖动并成一条历史
                                      'subtitle.fontSize'
                                  )
                          }
                        : {})}
                />
            </Card>

            <Card className="gap-3.5">
                <SectionHeading title="字幕样式" />

                <div className="flex w-full items-center justify-between">
                    {styleSwatches.map(({ id, label, color }) => (
                        <button
                            key={id}
                            type="button"
                            aria-label={label}
                            aria-pressed={id === settings.swatchId}
                            onClick={() =>
                                onSubtitleChange?.(
                                    { ...settings, swatchId: id },
                                    'subtitle.swatch'
                                )
                            }
                            className={`flex size-[34px] shrink-0 cursor-pointer items-center justify-center rounded-lg border bg-ed-swatch ${
                                id === settings.swatchId
                                    ? 'border-ed-accent'
                                    : 'border-ed-border'
                            }`}
                        >
                            {/* 色值由数据驱动，不能拼成 Tailwind 类名 */}
                            <span
                                aria-hidden="true"
                                className="text-ed-4xl font-bold"
                                style={{ color }}
                            >
                                T
                            </span>
                        </button>
                    ))}
                </div>

                {/*
                    右边这行平时说「应用到当前字幕轨」——那是**一句承诺**。
                    承诺没兑现时就得在同一个位置说清楚，而不是让它继续挂着，
                    否则用户下次打开发现样式变回去了，中间没有任何一处提醒过。
                */}
                <div className="flex w-full items-center justify-between gap-2">
                    <span className="shrink-0 text-ed-sm text-ed-text-2">
                        {selected?.label}
                    </span>
                    {subtitleSaveError ? (
                        <span
                            role="alert"
                            // 用现成的强调红，不为这一行新造一个颜色令牌
                            className="min-w-0 truncate text-ed-xs text-ed-accent"
                        >
                            {`没能存进工程：${subtitleSaveError}`}
                        </span>
                    ) : (
                        <span className="text-ed-xs text-ed-text-3">
                            {APPLY_HINT}
                        </span>
                    )}
                </div>
            </Card>
        </PanelShell>
    );
}
