import { Sparkles } from 'lucide-react';
import { useState } from 'react';

import {
    indexTtsVoiceId,
    isIndexTtsVoice
} from '@magicut-react-demo/video-agent/custom-voices';
import {
    DEFAULT_VOICE_ID,
    findVoice,
    VOICE_CATALOG
} from '@magicut-react-demo/video-agent/voices';

import MediaPicker from '@/renderer/components/create/MediaPicker';
import type { VoiceOption } from '@/renderer/components/create/VoiceSelect';
import VoiceSelect, {
    catalogOption
} from '@/renderer/components/create/VoiceSelect';
import type { CreateTab } from '@/renderer/data/create-fixtures';
import {
    SCRIPT_MAX_LENGTH,
    SCRIPT_PLACEHOLDER,
    tabs
} from '@/renderer/data/create-fixtures';
import type { UseMediaLibrary } from '@/renderer/data/use-media-library';
import { useVoiceSamples } from '@/renderer/data/use-voice-samples';

interface ScriptCardProps {
    /** 把文稿和选中的音色交出去。真正的创作在页面层发起 */
    onCreate: (input: { script: string; voiceId: string }) => void;
    /** 正在创作时禁用，避免重复发起 */
    busy?: boolean;
    media: UseMediaLibrary;
}

export default function ScriptCard({
    onCreate,
    busy = false,
    media
}: ScriptCardProps) {
    const [tab, setTab] = useState<CreateTab>('script');
    const [script, setScript] = useState('');
    const [voiceId, setVoiceId] = useState<string>(DEFAULT_VOICE_ID);
    const [menuOpen, setMenuOpen] = useState(false);

    /**
     * 自定义音色库。
     *
     * 创作页也要能选自己的音色——否则用户只能先用官方音色创建一条，
     * 再进编辑器重配一遍，而那等于把整条片子**合成两次**。
     */
    const samples = useVoiceSamples();
    const customVoices: VoiceOption[] = samples.samples.map((sample) => ({
        id: indexTtsVoiceId(sample.id),
        name: sample.name,
        desc: `我的音色 · ${(sample.durationMs / 1000).toFixed(1)} 秒`
    }));

    /**
     * 当前选中那一项。
     *
     * 官方目录查不到就去自定义音色里找；都找不到（选过的那条样本被删了）
     * 退回目录第一个——**不能让触发器显示一个已经不存在的音色**，
     * 否则点创建会拿着一个合成不了的 id 去跑一整轮。
     */
    const voice: VoiceOption = (() => {
        const official = findVoice(voiceId);
        if (official) return catalogOption(official);
        return (
            customVoices.find((item) => item.id === voiceId) ??
            catalogOption(VOICE_CATALOG[0]!)
        );
    })();

    /**
     * 选了自定义音色，而本地引擎用不了。
     *
     * 这里拦住比编辑器那边更要紧：创作是**一整轮**，走到合成那步之前
     * 已经调了好几次模型、花了钱，到那时才说"连不上本地 IndexTTS2"，
     * 前面那些全白跑。引擎状态还没探到（null）时不拦——那是"还不知道"。
     */
    const engineBlocked =
        isIndexTtsVoice(voice.id) &&
        samples.engine !== null &&
        !samples.engine.ready
            ? (samples.engine.reason ?? '本地音色引擎现在用不了')
            : undefined;

    return (
        // 卡片底色不透明：点阵特效由 CreatePage 垫在卡片背后，
        // 所以输入区里看不到点，不会干扰正在输入的文字
        <div className="relative w-full max-w-[1365px] rounded-[28px] border border-cr-card-border bg-cr-card px-10 pt-10 pb-9">
            <div className="flex flex-col">
                <div className="flex w-fit gap-1.5 rounded-3xl border border-cr-card-border bg-cr-tabs p-1">
                    {tabs.map((item) => {
                        const active = item.id === tab;

                        return (
                            <button
                                key={item.id}
                                type="button"
                                aria-pressed={active}
                                onClick={() => setTab(item.id)}
                                className={`cursor-pointer rounded-[20px] px-6 py-[13px] text-[20px] transition-colors duration-150 ${
                                    active
                                        ? 'bg-cr-tab-active font-bold text-white'
                                        : 'text-pj-nav-text'
                                }`}
                            >
                                {item.label}
                            </button>
                        );
                    })}
                </div>

                {tab === 'script' ? (
                    <>
                        <textarea
                            aria-label="视频文稿"
                            value={script}
                            maxLength={SCRIPT_MAX_LENGTH}
                            onChange={(event) => setScript(event.target.value)}
                            placeholder={SCRIPT_PLACEHOLDER}
                            className="mt-10 h-[140px] w-full resize-none bg-transparent text-[24px] text-white caret-white outline-none placeholder:text-cr-placeholder"
                        />
                        <span className="mt-2 text-[24px] text-cr-counter">
                            {script.length} / {SCRIPT_MAX_LENGTH}
                        </span>
                    </>
                ) : (
                    <div className="mt-10 flex h-[182px] w-full items-center justify-center rounded-2xl border border-dashed border-cr-card-border text-[20px] text-cr-placeholder">
                        拖入或点击上传口播音频
                    </div>
                )}

                <div className="mt-6 flex w-full items-center gap-[22px]">
                    <VoiceSelect
                        value={voice}
                        custom={customVoices}
                        open={menuOpen}
                        onToggle={() => setMenuOpen((prev) => !prev)}
                        onSelect={(id) => {
                            setVoiceId(id);
                            setMenuOpen(false);
                        }}
                        onClose={() => setMenuOpen(false)}
                    />

                    <MediaPicker media={media} />

                    <span className="flex-1" />

                    <button
                        type="button"
                        // 文稿为空时不让点：空提示词到主进程只会换来一个报错。
                        // 选了用不了的自定义音色同理，理由见 engineBlocked
                        disabled={
                            busy ||
                            script.trim().length === 0 ||
                            engineBlocked !== undefined
                        }
                        {...(engineBlocked ? { title: engineBlocked } : {})}
                        onClick={() =>
                            onCreate({
                                script: script.trim(),
                                voiceId: voice.id
                            })
                        }
                        className="flex h-13 w-[122px] shrink-0 cursor-pointer items-center justify-center gap-2 rounded-[10px] bg-linear-to-r from-[#F06AB0] to-[#8A5CFF] shadow-[0_6px_24px_#B04FE066] transition-transform duration-150 hover:scale-[1.03] active:scale-95 disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:scale-100"
                    >
                        <Sparkles size={18} className="text-white" />
                        <span className="text-[20px] font-bold text-white">
                            {busy ? '创作中' : '创建'}
                        </span>
                    </button>
                </div>
            </div>
        </div>
    );
}
