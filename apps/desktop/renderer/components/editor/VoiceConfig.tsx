import { CloudUpload, Mic, Sparkles } from 'lucide-react';
import { useState } from 'react';

import {
    indexTtsVoiceId,
    isIndexTtsVoice
} from '@magicut-react-demo/video-agent/custom-voices';
import {
    VOICE_CATALOG,
    voiceSubtitle
} from '@magicut-react-demo/video-agent/voices';

import type { VoiceSample } from '@/client/agent-ipc';
import type { ConfigImplementationProps } from '@/renderer/components/editor/ConfigPanel';
import PinnedFooterShell from '@/renderer/components/editor/PinnedFooterShell';
import SectionHeading from '@/renderer/components/editor/SectionHeading';
import Slider from '@/renderer/components/editor/Slider';
import VoiceRow from '@/renderer/components/editor/VoiceRow';
import { useVoicePreview } from '@/renderer/data/use-voice-preview';
import { useVoiceSamples } from '@/renderer/data/use-voice-samples';
import type { Voice } from '@/renderer/data/voice-fixtures';
import {
    DEFAULT_VOICE_ID,
    defaultVoiceParams,
    speedToRate,
    voiceParams,
    voices
} from '@/renderer/data/voice-fixtures';

function VoiceHeader() {
    return (
        <div className="flex w-full flex-col gap-1.5">
            <div className="flex w-full items-center gap-2">
                <Mic size={16} className="shrink-0 text-ed-accent" />
                <h2 className="text-ed-2xl font-bold text-ed-text">口播配音</h2>
            </div>
            <p className="w-full text-ed-base leading-ed text-ed-text-2">
                为当前文稿生成 AI
                口播音频。选择音色、调整参数后点击生成，配音将自动对齐到时间线。
            </p>
        </div>
    );
}

/**
 * 生成按钮。
 *
 * 点下去是**真的**用选中的音色把整条片子的口播重新合成一遍，
 * 并按新时长重排整条时间线（分镜起点、画面区间、字幕位置、画布总时长）。
 *
 * 合成期间锁住：按量计费，再点一次就是再花一遍钱，而且两次重排会打架。
 */
function GenerateButton({
    onClick,
    busy,
    blocked
}: {
    onClick?: (() => void) | undefined;
    busy: boolean;
    blocked?: string | undefined;
}) {
    const disabled = onClick === undefined || busy || blocked !== undefined;

    return (
        <button
            type="button"
            disabled={disabled}
            onClick={onClick}
            {...(blocked ? { title: blocked } : {})}
            className="flex h-[42px] w-full items-center justify-center gap-2 rounded-lg bg-ed-accent enabled:cursor-pointer disabled:cursor-not-allowed disabled:opacity-40"
        >
            <Sparkles
                size={16}
                className={`text-white ${busy ? 'animate-spin' : ''}`}
            />
            <span className="text-ed-lg font-bold text-white">
                {busy ? '正在生成…' : '生成口播稿'}
            </span>
        </button>
    );
}

/**
 * 口播模式的配置区。
 *
 * 对应 magicut-demo.pen 的 frame UuBmw（妙剪 Magicut — 口播-画面）
 * 里的 Right Panel — 配置区（YvwNh）。
 *
 * 三段式：标题常驻顶部，音色与参数在中段滚动，生成按钮吸在底部。
 * 设计稿用一个 flex-1 的 Spacer 把按钮顶到底，那只在画布高度恰好是 1094 时成立；
 * 窗口一矮按钮就被推出视口，得先滚到底才点得到。
 *
 * 音色选中态与两条参数都提成了状态：设计稿画的是静态的一帧，
 * 跟着 fixture 里写死的 `state` 走的话，点了也不会变。
 */
/**
 * 真实音色列表：与创作页那个下拉**同一份目录**
 * （`@magicut-react-demo/video-agent/voices` 的 19 个火山 2.0 中文音色）。
 *
 * 设计稿里那五个（晓晨/云泽/小雅/亦扬/若曦）是画稿时的占位，服务端根本没有——
 * 在这里选中它们，合成那步只会换来一个服务端拒绝。
 *
 * 头像底色按 id 稳定取色：同一个音色每次进来都是同一个颜色，
 * 不然翻页面时一片花。
 */
const AVATAR_COLORS = ['#7C5CFF', '#2F7BFF', '#FF6A9A', '#2FBF8F', '#F0A63C'];

function realVoices(
    usedId: string | undefined,
    /**
     * 已经由「自定义音色库」那一节列出来的 id。
     *
     * 不传这个的话，用自定义音色配出来的工程会让那条音色**同时出现在两节里**，
     * 而且两边都是选中态——看着像界面坏了。
     */
    listedElsewhere: ReadonlySet<string>
): Voice[] {
    const rows: Voice[] = VOICE_CATALOG.map((voice, index) => ({
        id: voice.id,
        name: voice.name,
        desc: voiceSubtitle(voice),
        color: AVATAR_COLORS[index % AVATAR_COLORS.length]!,
        state: 'idle'
    }));

    // 工程用的音色不在目录里（旧工程、目录换过代次、或者是条已经被删掉的
    // 自定义音色）时**照样列出来**：它是这条片子真实用过的那个，
    // 藏起来只会让人以为没选。
    //
    // 这一条**不随选中态进出**：选了别的之后它要是消失了，就再也换不回来了
    if (
        usedId !== undefined &&
        !rows.some((row) => row.id === usedId) &&
        !listedElsewhere.has(usedId)
    ) {
        rows.unshift({
            id: usedId,
            name: usedId,
            desc: isIndexTtsVoice(usedId)
                ? // 参考音频被删了，这条音色再也念不出声。说清楚是"没了"
                  // 而不是"不认识"——后者会让人去翻音色目录找它
                  '自定义音色 · 参考音频已不在库里'
                : '不在当前音色目录里',
            color: AVATAR_COLORS[0]!,
            state: 'idle'
        });
    }

    return rows;
}

/**
 * 用户自己传的样本 → 音色表里的一行。
 *
 * **和官方音色摆成同一种行**，不是另造一套控件：对用户来说"选谁来念"
 * 是同一件事，自己的音色摆成一个样子奇怪的附属区块，只会让人以为
 * 它和下面那颗生成按钮没关系。
 *
 * id 过一道命名空间（`custom:index-tts2:<样本 id>`）：这个值会被原样
 * 送进合成那一侧，由它据此分流到本地引擎。拼前缀这件事交给
 * `indexTtsVoiceId`，界面不该自己拼字符串。
 *
 * 名字就用原始文件名，**不去掉后缀**：上传列表、试听按钮、文件管理器里
 * 显示的是同一串字，少一次"这是不是我传的那个"的犹豫。
 */
function customVoices(
    samples: readonly VoiceSample[]
): { sampleId: string; voice: Voice }[] {
    return samples.map((sample, index) => ({
        // 删除要按**样本 id**，带前缀的那个是给合成用的。两者一起带着走，
        // 比回头从行里反解析省一次出错的机会
        sampleId: sample.id,
        voice: {
            id: indexTtsVoiceId(sample.id),
            name: sample.name,
            desc: `我的音色 · ${(sample.durationMs / 1000).toFixed(1)} 秒`,
            color: AVATAR_COLORS[index % AVATAR_COLORS.length]!,
            state: 'idle'
        }
    }));
}

export default function VoiceConfig({
    project,
    voice,
    onVoiceChange,
    regenerate
}: ConfigImplementationProps) {
    // 这条片子实际用的音色：从配音轨上取，不是从配置里猜
    const voiceTrack = project?.tracks.find((track) => track.kind === 'voice');
    const usedVoiceId = voiceTrack?.clips[0]?.provider.voiceId;

    /**
     * 用户点过的那个。没点过是 null，**不是**"没选"——
     * 此时该高亮的是工程真实用的那个（没有工程就是设计稿那一帧的晓晨）。
     * 把默认值直接塞进 state 的话，工程换了之后高亮会卡在旧的那个上。
     */
    const [pickedId, setPickedId] = useState<string | null>(null);
    const activeId =
        pickedId ?? (project ? usedVoiceId : DEFAULT_VOICE_ID) ?? undefined;

    /**
     * 音量与语速由**页面**持有：预览要按它播。
     * 没人接管时退回默认值，面板照样显示得对，但改不动——
     * 没有去处的输入不如不给。
     */
    const params = voice ?? defaultVoiceParams();

    /** 试听：真用那个音色合成一小段并播出来 */
    const preview = useVoicePreview();
    /** 自定义音色库：用户自己传进来的人声样本 */
    const samples = useVoiceSamples();

    /**
     * 语速滑杆换算成倍率，试听与重新生成都按它来。
     *
     * **只有本地引擎认**：火山那条合成接口没有这个参数。所以官方音色拖语速
     * 仍然只有预览在变，而用自己的音色时它是真的——界面上要分清楚这两件事。
     */
    const speedRate = speedToRate(params.speed);

    const withState = (list: readonly Voice[]): Voice[] =>
        list.map((voice) => ({
            ...voice,
            state: voice.id === activeId ? 'selected' : 'idle'
        }));

    const myRows = customVoices(samples.samples).map((row) => ({
        ...row,
        voice: withState([row.voice])[0]!
    }));
    const rows = withState(
        project
            ? realVoices(
                  usedVoiceId,
                  new Set(myRows.map((row) => row.voice.id))
              )
            : voices
    );
    // 选中的那条可能在两张表里的任何一张——官方与自定义是同一个单选
    const selected = [...rows, ...myRows.map((row) => row.voice)].find(
        (row) => row.state === 'selected'
    );

    /**
     * 选中的是自定义音色，而本地引擎用不了。
     *
     * 这种时候**必须在按下去之前拦住**：让它跑起来的话，用户会看着
     * "正在生成…"等上几秒，再换来一句连不上——而那几秒里他以为是在合成。
     *
     * 引擎状态还没探到（null）时不拦：那是"还不知道"，不是"不行"。
     */
    const engineBlocked =
        activeId !== undefined &&
        isIndexTtsVoice(activeId) &&
        samples.engine !== null &&
        !samples.engine.ready
            ? (samples.engine.reason ?? '本地音色引擎现在用不了')
            : undefined;

    // 没有桥这条更靠前：浏览器里连通道都没有，说引擎的事没有意义
    const generateBlocked = regenerate?.available
        ? engineBlocked
        : '重新生成只能在桌面端用';

    return (
        <PinnedFooterShell
            label="口播"
            header={<VoiceHeader />}
            footer={
                <div className="flex w-full flex-col gap-1.5">
                    <GenerateButton
                        busy={regenerate?.busy ?? false}
                        {...(regenerate?.available && activeId
                            ? {
                                  onClick: () =>
                                      regenerate.run(activeId, speedRate)
                              }
                            : {})}
                        {...(generateBlocked === undefined
                            ? {}
                            : { blocked: generateBlocked })}
                    />

                    {/* 九个分镜要逐个合成。只转圈不说进度的话，
                        用户不知道是快好了还是卡住了 */}
                    {regenerate?.progress ? (
                        <p className="text-center text-ed-sm text-ed-text-3">
                            {regenerate.progress.total === 0
                                ? regenerate.progress.label
                                : `第 ${regenerate.progress.done + 1} / ${
                                      regenerate.progress.total
                                  } 镜：${regenerate.progress.label}`}
                        </p>
                    ) : null}

                    {regenerate?.error ? (
                        <p
                            role="alert"
                            className="text-center text-ed-sm text-ed-accent"
                        >
                            {`生成失败：${regenerate.error}`}
                        </p>
                    ) : null}
                </div>
            }
        >
            <section className="flex w-full shrink-0 flex-col gap-2">
                <SectionHeading title="选择音色">
                    <span className="text-ed-sm text-ed-text-3">
                        已选 · {selected?.name ?? '未选'}
                    </span>
                </SectionHeading>
                <ul className="flex w-full flex-col gap-1">
                    {rows.map((voice) => (
                        <VoiceRow
                            key={voice.id}
                            voice={voice}
                            onSelect={() => setPickedId(voice.id)}
                            {...(preview.available
                                ? {
                                      onPreview: () =>
                                          preview.play(voice.id, speedRate)
                                  }
                                : {})}
                            previewPhase={
                                preview.activeId === voice.id
                                    ? preview.phase
                                    : 'idle'
                            }
                        />
                    ))}
                </ul>

                {/*
                    试听这件事有两种"没声音"：凭证没配（合成的是静音占位）、
                    请求失败。两种都比静悄悄什么也不发生值得说一句——
                    否则用户只会以为试听是坏的。
                */}
                {preview.error === null ? null : (
                    <p role="alert" className="text-ed-sm text-ed-accent">
                        {`试听失败：${preview.error}`}
                    </p>
                )}
                {preview.provider === 'mock' ? (
                    <p className="text-ed-sm text-ed-text-3">
                        还没配语音合成凭证，试听放的是等长的静音
                    </p>
                ) : null}
            </section>

            <section className="flex w-full shrink-0 flex-col gap-2">
                <SectionHeading title="自定义音色库">
                    <span className="text-ed-sm text-ed-text-3">
                        {`${samples.samples.length} 个音色`}
                    </span>
                </SectionHeading>

                {/*
                    已经传进来的样本，摆成和官方音色一样的可选行。
                    文件归应用管（复制进 userData），所以这里只认 id——
                    和媒体协议是同一条规矩。

                    试听走的是**合成**那条路（和官方音色同一个按钮语义：
                    "这个音色念出来什么样"），不是回放原始样本——
                    后者只能证明文件传上来了，证明不了克隆出来是什么效果。
                */}
                {myRows.length > 0 ? (
                    <ul className="flex w-full flex-col gap-1">
                        {myRows.map(({ sampleId, voice }) => (
                            <VoiceRow
                                key={voice.id}
                                voice={voice}
                                onSelect={() => setPickedId(voice.id)}
                                {...(preview.available
                                    ? {
                                          onPreview: () =>
                                              preview.play(voice.id, speedRate)
                                      }
                                    : {})}
                                onRemove={() => samples.remove(sampleId)}
                                previewPhase={
                                    preview.activeId === voice.id
                                        ? preview.phase
                                        : 'idle'
                                }
                            />
                        ))}
                    </ul>
                ) : null}

                <button
                    type="button"
                    disabled={!samples.available || samples.busy}
                    {...(samples.available
                        ? { onClick: samples.add }
                        : { title: '上传音色样本只能在桌面端用' })}
                    className="flex w-full flex-col items-center gap-1 rounded-lg border border-ed-border bg-ed-panel p-3 enabled:cursor-pointer disabled:cursor-not-allowed disabled:opacity-40"
                >
                    <CloudUpload size={18} className="text-ed-text-2" />
                    <span className="text-ed-base text-ed-text">
                        {samples.busy
                            ? '正在处理…'
                            : '上传音频样本，克隆你的音色'}
                    </span>
                    <span className="text-ed-xs text-ed-text-3">
                        支持 MP3 / WAV · 建议 10–30 秒清晰人声
                    </span>
                </button>

                {samples.error ? (
                    <p role="alert" className="text-ed-sm text-ed-accent">
                        {samples.error}
                    </p>
                ) : null}

                {/*
                    本地复刻引擎的状态。

                    它是**用户自己机器上的服务，随时可能没开**。不先说的话，
                    用户会选好自己的音色、点生成、等上几秒，再换来一句"连不上"——
                    而那几秒里他以为是在合成。

                    `engine` 还是 null 时什么都不说：那是"还没探到"，
                    和"探过了、连不上"不是一回事，前者没有任何可说的。
                */}
                {samples.engine && !samples.engine.ready ? (
                    <div className="flex w-full flex-col gap-1.5 rounded-lg border border-ed-border bg-ed-panel-2 p-2.5">
                        <span
                            role="alert"
                            className="text-ed-sm text-ed-text-2"
                        >
                            {samples.engine.reason ?? '本地音色复刻服务连不上'}
                        </span>
                        {/* 用户去把服务启起来之后会回来点它，
                            否则只能靠重开整个应用来刷新这个状态 */}
                        <button
                            type="button"
                            onClick={samples.recheckEngine}
                            className="cursor-pointer self-start text-ed-sm text-ed-accent"
                        >
                            重新检测
                        </button>
                    </div>
                ) : null}
            </section>

            <section className="flex w-full shrink-0 flex-col gap-3">
                <SectionHeading title="参数调整">
                    <button
                        type="button"
                        disabled={onVoiceChange === undefined}
                        onClick={() =>
                            onVoiceChange?.(defaultVoiceParams(), 'voice.reset')
                        }
                        className="text-ed-sm text-ed-text-3 enabled:cursor-pointer disabled:cursor-not-allowed disabled:opacity-40"
                    >
                        重置
                    </button>
                </SectionHeading>
                {voiceParams.map(({ key, label, format }) => {
                    const current = params[key];
                    return (
                        <Slider
                            key={key}
                            name={label}
                            label={
                                <span className="text-ed-base text-ed-text-2">
                                    {label}
                                </span>
                            }
                            value={format(current)}
                            percent={current}
                            {...(onVoiceChange
                                ? {
                                      onPercentChange: (next: number) =>
                                          onVoiceChange(
                                              { ...params, [key]: next },
                                              // 整段拖动并成一条历史
                                              `voice.${key}`
                                          )
                                  }
                                : {})}
                        />
                    );
                })}

                {/*
                    **语速对两条合成路的意义不一样，这句话必须说清楚。**

                    官方音色（火山）那条接口**没有语速参数**，拖了也只有预览
                    在变速；用自己的音色（本地 IndexTTS2）重新生成时它是真的——
                    合成就按这个速度出，再按实测新时长重排整条时间线。

                    笼统写一句"语速只影响预览"的话，用自己音色的人会以为
                    这个滑杆没用；反过来写"会改成片"，用官方音色的人导出之后
                    会发现根本没变。两种都是骗人。
                */}
                <p className="text-ed-sm text-ed-text-3">
                    {samples.engine?.ready
                        ? '用自己的音色重新生成时，语速会真的变；官方音色只有预览在变'
                        : '语速只影响预览播放；成片要变速需要用自己的音色重新生成'}
                </p>
            </section>
        </PinnedFooterShell>
    );
}
