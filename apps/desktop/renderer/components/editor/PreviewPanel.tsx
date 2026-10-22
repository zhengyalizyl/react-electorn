import {
    Maximize2,
    Minimize2,
    Pause,
    Play,
    Volume2,
    VolumeX
} from 'lucide-react';
import type { RefObject } from 'react';
import { useEffect, useRef, useState } from 'react';

import type { VideoProject } from '@magicut-react-demo/video-project';
import {
    clipsAt,
    formatPlayhead,
    sourceTimeMs
} from '@magicut-react-demo/video-project';

import IconButton from '@/renderer/components/editor/IconButton';
import { mediaUrl } from '@/renderer/data/bridge';
import type { SubtitleSettings } from '@/renderer/data/subtitle-style';
import {
    baseStyleOf,
    resolveSubtitleStyle,
    settingsFromProject,
    subtitlePreviewStyle
} from '@/renderer/data/subtitle-style';
import type { PreviewState } from '@/renderer/data/use-preview';
import type { VoiceParams } from '@/renderer/data/voice-fixtures';
import {
    defaultVoiceParams,
    speedToRate,
    volumeToGain
} from '@/renderer/data/voice-fixtures';

/**
 * 预览：**真的把这条片子放出来**。
 *
 * ## 这不是导出
 *
 * 画面、配音、字幕是三个元素叠在一起按播放头对齐播的，不是渲染好的视频文件。
 * 转场、裁切这些工程里的意图在这里**看不出效果**——那是导出那一步的事。
 * 所以右下角如实写着「预览（未导出）」。
 *
 * 导出已经接上了（`client/export-video.ts` 真跑 ffmpeg），但那是另一条路：
 * 这里**永远**是实时合成的近似，不会因为导出能用了就变成所见即所得。
 *
 * ## 为什么媒体元素被动跟随播放头
 *
 * 时钟在 `usePreview` 里自己走。跟着 `<video>` 的 `timeupdate` 走的话，
 * 没配上画面的分镜期间时间就不动了——那几秒配音还在响，画面却停在上一镜。
 *
 * 只在**该跳的时候**才 seek：每帧都写 `currentTime` 会把播放卡成幻灯片。
 *
 * ## 读不出来的素材要**指名道姓**
 *
 * 媒体元素加载失败时浏览器只会留一块黑屏，控制台那行报错用户看不到。
 * 于是「只有声音没有画面」这种状态既没人说得清，也无从查起——
 * 文件被移走了？还是这个容器解不了？
 * 出错时把**素材 id** 摆到画面上：渲染层手里没有路径（那是故意的），
 * 但拿着 id 去工程 JSON 里一查就知道是哪个文件。
 */

/** 超过这个差值才认为"跑偏了"，需要拉回播放头。太小会每帧都 seek */
const DRIFT_TOLERANCE_MS = 220;

function useFollowPlayhead(
    ref: RefObject<HTMLMediaElement | null>,
    options: {
        src: string | null;
        sourceMs: number;
        playing: boolean;
        muted?: boolean;
        /** 0–1。右侧口播面板那条音量滑杆说了算 */
        volume?: number;
        /** 播放倍速。语速滑杆说了算——**只影响预览**，不改成片 */
        rate?: number;
    }
): void {
    const {
        src,
        sourceMs,
        playing,
        muted = false,
        volume = 1,
        rate = 1
    } = options;

    useEffect(() => {
        const el = ref.current;
        if (!el || src === null) return;

        el.muted = muted;
        el.volume = volume;
        el.playbackRate = rate;
        const target = sourceMs / 1000;
        if (Math.abs(el.currentTime - target) * 1000 > DRIFT_TOLERANCE_MS) {
            el.currentTime = target;
        }

        if (playing) {
            // 浏览器可能因为自动播放策略拒绝——预览是用户点出来的，
            // 正常不会被拒；真被拒也不该让整个页面崩。
            // `play()` 在老实现里返回 undefined（jsdom 就是），所以要先判一下
            const started: unknown = el.play();
            if (started instanceof Promise) void started.catch(() => undefined);
        } else {
            el.pause();
        }
    }, [ref, src, sourceMs, playing, muted, volume, rate]);
}

export default function PreviewPanel({
    project,
    projectId,
    preview,
    scrubMs,
    subtitleSettings,
    voiceParams
}: {
    project?: VideoProject | undefined;
    /**
     * 工程目录名。媒体 URL 靠它定位——**渲染层只说 id，不说路径**，
     * 由主进程按工程 JSON 翻译成本地文件。
     */
    projectId?: string | undefined;
    /**
     * 播放时钟。**由页面持有，不在这里自己建**——时间线的播放头要跟着同一个
     * 时钟走，两边各建一个的话会各跑各的，看上去就是"播放头和画面对不上"。
     */
    preview: PreviewState;
    /**
     * 鼠标在时间线上划过时的时刻。
     *
     * 有值就**按它显示**（画面、配音、字幕都跳过去），但**不动时钟**——
     * 悬停预览是"看一眼"，移开就还原。真去改播放位置是点击才做的事。
     */
    scrubMs?: number | null | undefined;
    /**
     * 右侧字幕面板上正在编辑的那份设置。
     *
     * 不传就按工程里存的样式渲染——**不是**按一组写死的值。
     * 之前这里写死了 `14px / 白 / 一层柔和投影`，于是工程里存的字幕样式
     * （示例工程是 42px、4px 黑描边）从来没在预览里出现过。
     */
    subtitleSettings?: SubtitleSettings | undefined;
    /**
     * 右侧口播面板那两条滑杆。
     *
     * 之前它们只是面板里的两个数字——拖得动、读数也跟着变，
     * 但播出来的声音一点变化都没有。
     */
    voiceParams?: VoiceParams | undefined;
}) {
    const videoRef = useRef<HTMLVideoElement | null>(null);
    const voiceRef = useRef<HTMLAudioElement | null>(null);
    const stageRef = useRef<HTMLDivElement | null>(null);

    /**
     * 整块预览静音。
     *
     * 和下面那个"有真配音就压住素材原声"是**两回事**：那个是混音策略，
     * 这个是用户说"别出声"。两者取或——用户按了静音，任何一路都不该响。
     */
    const [muted, setMuted] = useState(false);
    const [fullscreen, setFullscreen] = useState(false);

    /**
     * 全屏状态**以浏览器为准**，不自己记一个布尔。
     *
     * 用户按 Esc 退出全屏时不会经过我们的按钮，自己记的那个值就永远停在
     * "全屏中"，图标从此是反的。
     */
    useEffect(() => {
        const sync = (): void =>
            setFullscreen(document.fullscreenElement === stageRef.current);
        document.addEventListener('fullscreenchange', sync);
        return () => document.removeEventListener('fullscreenchange', sync);
    }, []);

    const toggleFullscreen = (): void => {
        const el = stageRef.current;
        if (!el) return;
        // jsdom 里这两个方法根本不存在，而预览面板的组件测试要能跑
        if (document.fullscreenElement) {
            void document.exitFullscreen?.();
            return;
        }
        void el.requestFullscreen?.().catch(() => undefined);
    };

    // 悬停时按鼠标所在时刻取片段；没悬停就用时钟的
    const scrubbing = scrubMs !== null && scrubMs !== undefined;
    const displayMs = scrubbing ? scrubMs : preview.timeMs;
    const active =
        scrubbing && project ? clipsAt(project, scrubMs) : preview.active;
    const { video, voice, subtitle, music } = active;

    const videoSrc = mediaUrl(projectId, 'video', video?.assetId);
    const voiceSrc = mediaUrl(projectId, 'audio', voice?.assetId);

    // 换了片段就把上一条错误清掉，否则会一直挂着一句过期的报错
    const [videoFailed, setVideoFailed] = useState<string | null>(null);
    const [voiceFailed, setVoiceFailed] = useState<string | null>(null);
    useEffect(() => setVideoFailed(null), [videoSrc]);
    useEffect(() => setVoiceFailed(null), [voiceSrc]);

    /**
     * 配音是不是占位静音。
     *
     * 真 TTS 还没接（plan.md 待决 #2），Mock provider 生成的 wav 长度对、
     * **采样点全是 0**。这时候再把素材原声压掉，整条片子就一点声音都没有——
     * 用户只会以为播放器坏了。
     */
    const voiceIsPlaceholder = voice?.provider.name === 'mock';

    /**
     * 这一刻有哪些东西是"写进工程了但听不到/看不到"的。
     *
     * **静悄悄地不播是最糟的表现**：时间线上明明有一条音乐轨，预览里一点声音
     * 没有，用户只会以为播放器坏了，或者以为自己哪里设置错了。
     *
     * 配乐尤其如此——曲库是内置曲目的**清单**，仓库里并没有那些 mp3
     * （`absolutePath` 落盘时就是 null）。选得出来、播不了。
     */
    const notes: string[] = [];
    if (voiceIsPlaceholder) {
        notes.push('配音是占位静音（真实配音未接入），当前播放的是素材原声');
    }
    if (music && project?.assets[music.assetId]?.absolutePath == null) {
        notes.push(
            '配乐已选好但没有音频文件（内置曲库只有清单），预览里听不到'
        );
    }

    useFollowPlayhead(videoRef, {
        src: videoSrc,
        sourceMs: video ? sourceTimeMs(video, displayMs) : 0,
        // 悬停划动时定格看画面，不出声——划过去的那一路声音是噪音
        playing: preview.playing && !scrubbing,
        // 有真配音时压住素材原声（口播片里它会和旁白抢）；
        // 配音是占位静音时放原声，否则什么都听不到。
        // 用户按了静音则一律不出声
        muted:
            muted || (voiceIsPlaceholder ? false : (video?.muteSource ?? true)),
        // 配音是占位静音时听的就是素材原声，音量滑杆也得管住它，
        // 否则"把音量拖到 0"只在有真配音时有效，那是一种更难查的半失效
        volume: volumeToGain(voiceParams?.volume ?? 100)
    });
    const params = voiceParams ?? defaultVoiceParams();
    const voiceVolume = volumeToGain(params.volume);
    const voiceRate = speedToRate(params.speed);

    useFollowPlayhead(voiceRef, {
        src: voiceSrc,
        sourceMs: voice ? sourceTimeMs(voice, displayMs) : 0,
        playing: preview.playing && !scrubbing,
        muted,
        volume: voiceVolume,
        rate: voiceRate
    });

    const progress =
        preview.durationMs === 0 ? 0 : (displayMs / preview.durationMs) * 100;

    /**
     * 字幕长什么样：底稿来自工程，面板上改过的那几项盖在上面。
     *
     * 面板没传设置时按工程原样渲染——那也是**工程里真实存着的样式**，
     * 不是一组写死的值。
     */
    const subtitleBase = baseStyleOf(project);
    const subtitleStyle = resolveSubtitleStyle(
        subtitleBase,
        subtitleSettings ?? settingsFromProject(project)
    );
    const subtitleVisible = subtitleSettings?.visible ?? true;

    return (
        <section
            aria-label="预览"
            className="flex min-w-0 flex-1 flex-col bg-ed-bg px-3 pt-10"
        >
            {/*
                `container-type: size` 是字幕字号的**前提**：字号写成 cqh
                （容器高度的百分之几），没有这一句的话 cq 单位会退到视口去算，
                字幕会大得离谱。见 subtitle-style.ts 的 `subtitlePreviewStyle`。
            */}
            <div
                ref={stageRef}
                className="relative min-h-0 flex-1 overflow-hidden rounded-[4px] border border-[#2C2C32] bg-[#131316] [container-type:size]"
            >
                {videoSrc ? (
                    <video
                        ref={videoRef}
                        src={videoSrc}
                        aria-label="预览画面"
                        className="size-full object-contain"
                        playsInline
                        onError={() => setVideoFailed(video?.assetId ?? '?')}
                    />
                ) : (
                    <p className="flex size-full items-center justify-center text-ed-md text-ed-text-3">
                        {project
                            ? '这一段没有画面，只有配音'
                            : '打开一个工程就能预览'}
                    </p>
                )}

                {/*
                    字幕叠在画面上，**跟着播放头换**——`clipsAt` 每帧按时间取
                    当前那一条，所以这里不需要自己算，换掉哪一条由时间说了算。

                    颜色、字号、描边**全部来自工程里的 `SubtitleStyle`**（右侧面板
                    改的也是它），不再写死在类名里：写死的话，右侧点了色卡预览
                    纹丝不动，而且工程里存的样式从来不会被显示出来。

                    留在类名里的只有位置——距底 100px、左右居中，那是版式不是样式。
                */}
                {subtitle && subtitleVisible ? (
                    <p
                        data-testid="preview-subtitle"
                        style={subtitlePreviewStyle(
                            subtitleStyle,
                            project?.canvas.height ?? 0
                        )}
                        className="pointer-events-none absolute inset-x-6 bottom-[100px] leading-[1.4]"
                    >
                        {subtitle.text}
                    </p>
                ) : null}

                {voiceSrc ? (
                    <audio
                        ref={voiceRef}
                        src={voiceSrc}
                        aria-label="预览配音"
                        onError={() => setVoiceFailed(voice?.assetId ?? '?')}
                    />
                ) : null}

                {/* 黑屏不会自己解释自己：把读不出来的文件名摆出来 */}
                {videoFailed === null ? null : (
                    <p className="absolute inset-0 flex items-center justify-center bg-[#131316] px-6 text-center text-ed-md text-ed-text-3">
                        {`这一段的画面读不出来：${videoFailed}`}
                    </p>
                )}
            </div>

            {voiceFailed === null ? null : (
                <p className="mt-2 text-ed-sm text-ed-text-3">
                    {`这一段的配音读不出来：${voiceFailed}`}
                </p>
            )}

            {/* 听不到的东西要**说出来**：静悄悄地放，用户只会以为播放器坏了 */}
            {notes.map((note) => (
                <p key={note} className="mt-2 text-ed-sm text-ed-text-3">
                    {note}
                </p>
            ))}

            {/* 进度条。点哪儿跳哪儿——拖动交互留到有人真的需要时再做 */}
            <button
                type="button"
                aria-label="跳转"
                disabled={preview.durationMs === 0}
                onClick={(event) => {
                    const rect = event.currentTarget.getBoundingClientRect();
                    const ratio = (event.clientX - rect.left) / rect.width;
                    preview.seek(ratio * preview.durationMs);
                }}
                className="mt-3 h-1 w-full cursor-pointer rounded-full bg-ed-border disabled:cursor-not-allowed"
            >
                <span
                    aria-hidden="true"
                    style={{ width: `${progress}%` }}
                    className="block h-full rounded-full bg-ed-text"
                />
            </button>

            <div className="flex h-[82px] shrink-0 items-center justify-between px-3">
                <span className="font-ed-mono text-ed-lg tracking-[0.5px] text-ed-text">
                    {formatPlayhead(displayMs)} /{' '}
                    {formatPlayhead(preview.durationMs)}
                </span>
                <IconButton
                    icon={preview.playing ? Pause : Play}
                    label={preview.playing ? '暂停' : '播放'}
                    size={22}
                    onClick={preview.toggle}
                    className="text-ed-text"
                />
                <div className="flex items-center gap-[26px]">
                    <IconButton
                        icon={muted ? VolumeX : Volume2}
                        label={muted ? '取消静音' : '静音'}
                        size={18}
                        onClick={() => setMuted((value) => !value)}
                        className="text-ed-text-2"
                    />
                    <IconButton
                        icon={fullscreen ? Minimize2 : Maximize2}
                        label={fullscreen ? '退出全屏' : '全屏'}
                        onClick={toggleFullscreen}
                        className="text-ed-text-2"
                    />
                </div>
            </div>
        </section>
    );
}
