import { CircleCheck, Loader2, Play, Square, Trash2 } from 'lucide-react';

import IconButton from '@/renderer/components/editor/IconButton';
import type { VoicePreviewPhase } from '@/renderer/data/use-voice-preview';
import type { Voice } from '@/renderer/data/voice-fixtures';

/**
 * 音色列表的一行。
 *
 * 选中行与普通行只差底色、描边、名字字重和那个对勾，
 * 不值得拆成两个组件——和 ShotCard 的处理不同，那里两态的结构差得更多。
 *
 * 选中按钮和试听按钮是兄弟节点而不是嵌套：button 套 button 是非法结构，
 * 键盘和读屏都会出问题。
 */
export default function VoiceRow({
    voice,
    onSelect,
    onPreview,
    onRemove,
    previewPhase = 'idle'
}: {
    voice: Voice;
    onSelect?: () => void;
    /** 试听。不传时按钮置灰——浏览器里合成不了，让它看着能点只会骗人 */
    onPreview?: (() => void) | undefined;
    /**
     * 删掉这条音色。**只有自定义音色有**：官方目录不是用户的东西，
     * 给它一个删除按钮等于许下一个做不到的承诺。
     */
    onRemove?: (() => void) | undefined;
    /** 这一行当前的试听状态 */
    previewPhase?: VoicePreviewPhase | undefined;
}) {
    const selected = voice.state === 'selected';

    /**
     * 合成要走一次网络请求，**不是瞬间的事**。
     * 按钮不变样的话，用户会在那一两秒里反复点，于是排队合成好几遍。
     */
    const icon =
        previewPhase === 'loading'
            ? Loader2
            : previewPhase === 'playing'
              ? Square
              : Play;
    const previewLabel =
        previewPhase === 'loading'
            ? `正在合成 ${voice.name}`
            : previewPhase === 'playing'
              ? `停止试听 ${voice.name}`
              : `试听 ${voice.name}`;

    return (
        <li
            className={`flex w-full items-center gap-2.5 rounded-lg border px-2.5 py-1.5 ${
                selected
                    ? 'border-ed-accent bg-ed-panel-2'
                    : 'border-ed-border bg-ed-panel'
            }`}
        >
            <button
                type="button"
                aria-pressed={selected}
                onClick={onSelect}
                className="flex min-w-0 flex-1 cursor-pointer items-center gap-2.5 text-left"
            >
                <span
                    aria-hidden="true"
                    className="flex size-7 shrink-0 items-center justify-center rounded-full text-ed-base font-bold text-white"
                    style={{ backgroundColor: voice.color }}
                >
                    {voice.name[0]}
                </span>
                {/* 行高压到 1.2：默认行高会把 40px 的音色行撑高，
                    五行累计溢出会把底部参数区挤出面板 */}
                <span className="flex min-w-0 flex-col gap-0.5 leading-[1.2]">
                    <span
                        className={`text-ed-md text-ed-text ${selected ? 'font-bold' : ''}`}
                    >
                        {voice.name}
                    </span>
                    <span className="text-ed-sm text-ed-text-3">
                        {voice.desc}
                    </span>
                </span>
            </button>

            {selected ? (
                <CircleCheck size={16} className="shrink-0 text-ed-accent" />
            ) : null}

            <IconButton
                icon={icon}
                label={previewLabel}
                size={14}
                disabled={onPreview === undefined}
                {...(onPreview ? { onClick: onPreview } : {})}
                {...(onPreview === undefined
                    ? { title: '试听只能在桌面端用' }
                    : {})}
                className={`shrink-0 text-ed-text-2 disabled:cursor-not-allowed disabled:opacity-40 ${
                    previewPhase === 'loading' ? 'animate-spin' : ''
                }`}
            />

            {onRemove ? (
                <IconButton
                    icon={Trash2}
                    label={`删除 ${voice.name}`}
                    size={14}
                    onClick={onRemove}
                    className="shrink-0 text-ed-text-2"
                />
            ) : null}
        </li>
    );
}
