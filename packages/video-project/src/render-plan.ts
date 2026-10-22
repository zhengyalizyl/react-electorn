import {
    beautyFilters,
    beautyIsNoop,
    blurSigma,
    featherSigma,
    mattingIsNoop,
    toFfmpegColor
} from './effects';
import type { SubtitleClip, VideoClip, VideoProject } from './schema';

/**
 * 工程 → ffmpeg 命令。**纯函数**。
 *
 * ## 为什么要把它单独拎出来
 *
 * 渲染出错时最难查的不是 ffmpeg，是"我们到底给它下了什么指令"。
 * 命令由纯函数生成，就能脱离 ffmpeg 直接断言：这一镜有没有被裁掉、
 * 定格那镜补了多久、音量换算对不对。真跑一遍只用来验收，不用来排查。
 *
 * ## 这一版渲染什么、不渲染什么
 *
 * 渲染：画面（按源内区间裁切、缩放填满画布、定格补帧）、口播、配乐、
 * 字幕（**软字幕**，见下）。
 *
 * **不渲染转场**。工程里 `transitions` 有 fade/cut 的意图，但做交叉溶解要把
 * 相邻两镜重叠起来，那会改变总时长——而总时长是由配音定死的（不变量 4）。
 * 要么改时间模型，要么偷偷吞掉几帧，两个都不该在导出这一步悄悄发生。
 *
 * ## 字幕为什么是软字幕
 *
 * 烧进画面需要 `subtitles`（libass）或 `drawtext`（freetype）滤镜。
 * **常见的 ffmpeg 构建两个都没有**（本机这个就是），硬写出来的命令
 * 在别人机器上也许能跑、在你机器上直接报"No such filter"。
 *
 * 所以这里走 `mov_text`：它是 **muxer 不是滤镜**，不依赖任何外部库，
 * 播放器（QuickTime / VLC / 浏览器）都认。代价是字体样式用不上——
 * 工程里那份 `SubtitleStyle` 的颜色描边在软字幕里表达不出来。
 * 要烧进画面得换一个带 libass 的 ffmpeg，那是打包那一步的事。
 */

export class RenderPlanError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'RenderPlanError';
    }
}

/**
 * 一个视频片段的逐帧遮罩。由渲染层跑分割模型产出，主进程落成临时文件。
 *
 * ## 为什么是 rawvideo 而不是一个视频文件
 *
 * 遮罩是**要拿去做数学的**，不是拿给人看的。走 h264 的话，色块边缘的压缩噪声
 * 会直接变成抠图边缘的毛刺，而且无从分辨"这圈毛刺是模型抠的还是编码器糊的"。
 * rawvideo 没有这个问题，代价只是临时文件大一些（256×256 灰度，一帧 64KB）。
 *
 * ## 为什么是 256×256 而不是画布分辨率
 *
 * 分割模型本来就只输出 256×256，放大到 1080p 再存一遍不会多出任何信息，
 * 只会让临时文件涨 30 倍。放大交给 ffmpeg，羽化那一步的高斯模糊顺带把
 * 放大的阶梯磨平。
 */
export interface ClipMasks {
    /** 人像 alpha 遮罩。抠图要用 */
    alphaPath?: string | undefined;
    /** 皮肤区域遮罩。限定皮肤的美颜要用 */
    skinPath?: string | undefined;
    /** 遮罩的边长（正方形）。模型输出多大就是多大 */
    size: number;
    /** 遮罩的帧率。必须和片段的 `fps` 对齐，否则越到后面错位越多 */
    fps: number;
}

export interface RenderPlanOptions {
    /** 输出文件绝对路径 */
    outPath: string;
    /**
     * 字幕文件（SRT）绝对路径。不给就不带字幕轨。
     *
     * 由调用方先写到临时文件再传进来——**纯函数不碰磁盘**。
     */
    subtitlePath?: string | undefined;
    /**
     * 逐帧遮罩，按 clipId 索引。
     *
     * 同样由调用方先落盘再传进来。**没有遮罩的片段不会被抠图**——
     * 宁可原样渲染，也好过拿一张不存在的蒙版去合成出一片透明。
     */
    masks?: Record<string, ClipMasks> | undefined;
    /**
     * 背景图的**绝对路径**，按 clipId 索引。
     *
     * 工程里存的是相对工程目录的路径（工程要能整体拷走），解析成绝对路径是
     * 调用方的事——纯函数不知道工程目录在哪，也不该知道。
     */
    backgroundImages?: Record<string, string> | undefined;
}

export interface RenderPlan {
    args: string[];
    /** 成片总时长，用来算进度百分比 */
    durationMs: number;
    /** 这次渲染用到的素材绝对路径，供调用方做存在性检查 */
    inputs: string[];
}

/** 毫秒 → ffmpeg 认的秒（三位小数）。拼字符串时统一走它，免得各处精度不一 */
export function toSeconds(ms: number): string {
    return (ms / 1000).toFixed(3);
}

/**
 * 增益（dB）→ ffmpeg `volume` 滤镜的参数。
 *
 * ffmpeg 认 `volume=-6dB` 这种写法，所以直接带单位传过去，
 * 不自己换算成倍率——少一处可能算错的地方。
 */
function volumeArg(gainDb: number): string {
    return `volume=${gainDb}dB`;
}

/**
 * 滤镜参数统一保留三位小数。
 *
 * 不收口的话 `0.6 * 40` 这种会写成 `24.000000000000004` 进命令行——
 * 能跑，但出错时对着那串数字排查格外费劲。
 */
function n3(value: number): string {
    return String(Number(value.toFixed(3)));
}

/**
 * 皮肤蒙版的羽化，固定 6 像素。
 *
 * 不给用户调：这不是风格选择，是**接缝**。边界硬的话，磨过的脸和没磨的脖子
 * 之间会有一道看得见的线，而没有人会想要那道线。抠图那边的 `featherPx`
 * 是另一回事——它决定人像与新背景怎么过渡，那确实因素材而异。
 */
const DEFAULT_SKIN_FEATHER_PX = 6;

/** 这个片段有没有任何效果要进滤镜链 */
function hasEffects(clip: VideoClip): boolean {
    return (
        !mattingIsNoop(clip.effects.matting) ||
        !beautyIsNoop(clip.effects.beauty)
    );
}

function assetPathOf(project: VideoProject, assetId: string): string {
    const asset = project.assets[assetId as keyof typeof project.assets];
    if (!asset) {
        throw new RenderPlanError(`工程里没有这个素材：${assetId}`);
    }
    if (!asset.absolutePath) {
        throw new RenderPlanError(
            `素材 ${assetId} 没有本地路径，渲染不了（内置曲库只有清单，没有文件）`
        );
    }
    return asset.absolutePath;
}

/** SRT 的时间戳：`00:00:08,200` */
export function srtTimestamp(ms: number): string {
    const total = Math.max(0, Math.round(ms));
    const h = Math.floor(total / 3_600_000);
    const m = Math.floor((total % 3_600_000) / 60_000);
    const s = Math.floor((total % 60_000) / 1000);
    const milli = total % 1000;
    const pad = (n: number, width = 2): string =>
        String(n).padStart(width, '0');
    return `${pad(h)}:${pad(m)}:${pad(s)},${pad(milli, 3)}`;
}

/**
 * 字幕轨 → SRT 文本。
 *
 * 按时间排序：SRT 的序号必须递增，而轨道里的顺序只是写入顺序，不保证有序。
 */
export function buildSrt(project: VideoProject): string {
    const clips: SubtitleClip[] = [];
    for (const track of project.tracks) {
        if (track.kind !== 'subtitle') continue;
        clips.push(...track.clips);
    }
    if (clips.length === 0) return '';

    return (
        clips
            .slice()
            .sort((a, b) => a.startMs - b.startMs)
            .map(
                (clip, index) =>
                    `${index + 1}\n` +
                    `${srtTimestamp(clip.startMs)} --> ` +
                    `${srtTimestamp(clip.startMs + clip.durationMs)}\n` +
                    `${clip.text}\n`
            )
            .join('\n') + '\n'
    );
}

export function buildRenderPlan(
    project: VideoProject,
    options: RenderPlanOptions
): RenderPlan {
    const { width, height, fps, durationMs: totalMs } = project.canvas;
    if (project.scenes.length === 0) {
        throw new RenderPlanError('这条片子还没有分镜，没有东西可渲染');
    }

    /**
     * 输入和输出选项**分开攒**。
     *
     * ffmpeg 的命令行是位置相关的：`-map` 这类输出选项一旦排在某个 `-i`
     * 前面，它就会被当成那个输入的选项，直接报
     * 「cannot be applied to input url ... Move this option before the file」。
     *
     * 边拼边 push 到同一个数组里就很容易踩中——字幕输入是最后才知道要不要加的，
     * 而那时候 `-map` 已经写进去了。拆成两段，最后一次性接起来。
     */
    const inputArgs: string[] = [];
    const outputArgs: string[] = [];
    const inputs: string[] = [];
    const filters: string[] = [];

    /** 下一个 `-i` 的序号。每加一个输入就自增，顺序必须和 inputArgs 里一致 */
    let inputIndex = 0;

    const addInput = (file: string, pre: string[]): number => {
        inputArgs.push(...pre, '-i', file);
        inputs.push(file);
        return inputIndex++;
    };

    // ── 画面：一镜一个输入 ────────────────────────────────────────────────
    //
    // **一个 clip 一个 `-i`**，而不是一个文件一个输入再用 trim 切。
    // 同一个素材被两镜用到时 trim 方案要共享解码器、还要处理时间戳偏移；
    // 多开一个输入让 ffmpeg 自己 seek，便宜且不会错。
    const videoLabels: string[] = [];

    project.scenes.forEach((scene, index) => {
        const clip = project.tracks
            .filter((track) => track.kind === 'video')
            .flatMap((track) => (track.kind === 'video' ? track.clips : []))
            .find((item) => item.id === scene.refs.video);

        if (!clip) {
            throw new RenderPlanError(`分镜 ${scene.id} 找不到视频片段`);
        }

        const span = clip.outMs - clip.inMs;
        const file = assetPathOf(project, clip.assetId);
        // `-ss` 放在 `-i` 前面是**输入定位**：ffmpeg 直接跳到那个位置解码，
        // 比解完整段再丢快得多，而且输出时间戳会归零
        const idx = addInput(file, [
            '-ss',
            toSeconds(clip.inMs),
            '-t',
            toSeconds(span)
        ]);

        const anchorX = clip.crop.anchorX;
        const anchorY = clip.crop.anchorY;

        /**
         * 素材比这一镜短时**定格在最后一帧**。
         *
         * `tpad` 克隆最后一帧补满剩下的时间。不补的话 concat 之后
         * 整条片子会比音频短一截，而音画从那一刻起全部错位。
         *
         * ⚠️ 遮罩链要补**一模一样的一段**，否则定格那几秒人像不动、
         * 蒙版却已经走到头，抠图会在片尾突然失效。
         */
        const holdFilter =
            clip.holdLastFrame && span < clip.durationMs
                ? `tpad=stop_mode=clone:stop_duration=` +
                  `${toSeconds(clip.durationMs - span)}`
                : null;

        const chain = [
            // 先铺满画布再裁：`increase` 保证短边填满，不会出黑边
            `scale=${width}:${height}:force_original_aspect_ratio=increase`,
            // 裁切锚点来自索引期的主体位置分析，人脸才不会被切掉半张
            `crop=${width}:${height}:` +
                `(iw-${width})*${anchorX}:(ih-${height})*${anchorY}`,
            `fps=${fps}`,
            'setsar=1'
        ];
        if (holdFilter) chain.push(holdFilter);

        const label = `v${index}`;

        /**
         * 没有效果的片段**走原来那条路，一个字都不改**。
         *
         * 这不是优化，是**兜底**：这次改动动的是所有人的导出链路，
         * 而绝大多数片子不会开抠图美颜。把它们和效果链彻底岔开，
         * 效果这边写错了也波及不到它们。
         */
        if (!hasEffects(clip)) {
            filters.push(
                `[${idx}:v]${[...chain, 'format=yuv420p'].join(',')}[${label}]`
            );
            videoLabels.push(`[${label}]`);
            return;
        }

        // 效果链的中间标签全带上镜号，避免两镜之间串台
        const n = index;
        filters.push(`[${idx}:v]${chain.join(',')}[src${n}]`);

        const { matting, beauty } = clip.effects;
        const mattingOn = !mattingIsNoop(matting);
        const background = matting.background;
        // 原背景虚化要**再拿一份没动过的画面**：美颜过的那份不能当背景，
        // 否则磨皮会连背景一起磨，虚化之前就已经糊过一次了
        const needsBlurCopy = mattingOn && background.kind === 'blur';

        let current = `src${n}`;
        if (needsBlurCopy) {
            filters.push(`[src${n}]split=2[fgsrc${n}][bgsrc${n}]`);
            current = `fgsrc${n}`;
        }

        const masks = options.masks?.[clip.id];

        // ── 美颜 ──────────────────────────────────────────────────────────
        const beautyChain = beautyFilters(beauty);
        if (beautyChain.length > 0) {
            const skinMask =
                beauty.skinOnly && masks?.skinPath
                    ? maskLabel(
                          masks,
                          masks.skinPath,
                          `skin${n}`,
                          // 皮肤蒙版也要羽化：边界是硬的话，磨过的脸和没磨的
                          // 脖子之间会出现一道看得见的接缝
                          DEFAULT_SKIN_FEATHER_PX
                      )
                    : null;

            if (skinMask === null) {
                /**
                 * 整帧美颜。
                 *
                 * 开了 `skinOnly` 却没有蒙版时也走这里——**宁可整帧磨，
                 * 也好过悄悄不磨**。界面那边会说清楚这一镜没跑出蒙版。
                 */
                filters.push(
                    `[${current}]${beautyChain.join(',')}[beauty${n}]`
                );
            } else {
                /**
                 * 只在皮肤区域美颜。
                 *
                 * 用 `alphamerge` + `overlay` 而不是 `maskedmerge`：后者要求
                 * 三路输入**像素格式完全一致**，于是灰度蒙版得先转成 yuv420p，
                 * 而它的 U/V 两个平面会被当成权重一起参与混合——
                 * 结果是脸上的颜色被冲淡。alphamerge 只认亮度，没有这个问题，
                 * 羽化过的边缘也能正确地半透明过渡。
                 */
                filters.push(
                    `[${current}]split=2[bplain${n}][braw${n}]`,
                    `[braw${n}]${beautyChain.join(',')},format=yuva420p[bdone${n}]`,
                    `[bdone${n}][${skinMask}]alphamerge[bmask${n}]`,
                    `[bplain${n}][bmask${n}]overlay=format=auto[beauty${n}]`
                );
            }
            current = `beauty${n}`;
        }

        // ── 抠图换背景 ────────────────────────────────────────────────────
        if (mattingOn) {
            const alphaPath = masks?.alphaPath;
            if (!masks || !alphaPath) {
                throw new RenderPlanError(
                    `分镜 ${scene.id} 开了抠图，但没有人像蒙版——` +
                        `请先在编辑器里等这一镜的蒙版跑完再导出`
                );
            }

            const alpha = maskLabel(
                masks,
                alphaPath,
                `alpha${n}`,
                matting.featherPx
            );

            // 背景三选一：虚化用那份没动过的副本，纯色/渐变凭空生成，
            // 图片当成一个真实输入加进来
            const bgLabel = `bg${n}`;
            switch (background.kind) {
                case 'blur': {
                    filters.push(
                        `[bgsrc${n}]gblur=sigma=` +
                            `${n3(blurSigma(background.strength))}[${bgLabel}]`
                    );
                    break;
                }
                case 'color': {
                    const bgIdx = addInput(
                        `color=c=${toFfmpegColor(background.color)}:` +
                            `s=${width}x${height}:r=${fps}:` +
                            `d=${toSeconds(clip.durationMs)}`,
                        ['-f', 'lavfi']
                    );
                    filters.push(`[${bgIdx}:v]setsar=1[${bgLabel}]`);
                    break;
                }
                case 'gradient': {
                    const bgIdx = addInput(
                        `gradients=s=${width}x${height}:` +
                            `c0=${toFfmpegColor(background.from)}:` +
                            `c1=${toFfmpegColor(background.to)}:` +
                            `r=${fps}:d=${toSeconds(clip.durationMs)}`,
                        ['-f', 'lavfi']
                    );
                    filters.push(`[${bgIdx}:v]setsar=1[${bgLabel}]`);
                    break;
                }
                case 'image': {
                    const imagePath = options.backgroundImages?.[clip.id];
                    if (!imagePath) {
                        throw new RenderPlanError(
                            `分镜 ${scene.id} 的背景图找不到了：` +
                                `${background.path}`
                        );
                    }
                    // `-loop 1` 把一张图变成一条流；`-t` 决定它铺多久
                    const bgIdx = addInput(imagePath, [
                        '-loop',
                        '1',
                        '-framerate',
                        String(fps),
                        '-t',
                        toSeconds(clip.durationMs)
                    ]);
                    filters.push(
                        `[${bgIdx}:v]scale=${width}:${height}:` +
                            `force_original_aspect_ratio=increase,` +
                            `crop=${width}:${height},fps=${fps},` +
                            `setsar=1[${bgLabel}]`
                    );
                    break;
                }
            }

            filters.push(
                `[${current}]format=yuva420p[fg${n}]`,
                `[fg${n}][${alpha}]alphamerge[fga${n}]`,
                `[${bgLabel}][fga${n}]overlay=format=auto[comp${n}]`
            );
            current = `comp${n}`;
        }

        /**
         * 收口。`setsar=1,format=yuv420p` 必须在**最后**：
         * concat 要求所有片段的像素格式、SAR、分辨率完全一致，
         * 而中途为了合成换过 yuva420p。少这一句，开了效果的那几镜
         * 会在 concat 处直接报「Input link parameters do not match」。
         */
        filters.push(`[${current}]setsar=1,format=yuv420p[${label}]`);
        videoLabels.push(`[${label}]`);

        /** 遮罩链：拉到画布大小、转灰度、补上和画面一样的定格、再羽化 */
        function maskLabel(
            spec: ClipMasks,
            maskPath: string,
            outLabel: string,
            featherPx: number
        ): string {
            const maskIdx = addInput(maskPath, [
                '-f',
                'rawvideo',
                '-pix_fmt',
                'gray',
                '-s',
                `${spec.size}x${spec.size}`,
                '-r',
                String(spec.fps)
            ]);

            const maskChain = [
                // 蒙版是按正方形推理出来的，拉回画布比例时**不保持宽高比**——
                // 它和画面是像素对像素的对应关系，保比会让它和人像错位
                `scale=${width}:${height}`,
                'format=gray',
                `fps=${fps}`,
                'setsar=1'
            ];
            if (holdFilter) maskChain.push(holdFilter);

            const sigma = featherSigma(featherPx);
            if (sigma > 0) maskChain.push(`gblur=sigma=${n3(sigma)}`);

            filters.push(`[${maskIdx}:v]${maskChain.join(',')}[${outLabel}]`);
            return outLabel;
        }
    });

    filters.push(
        `${videoLabels.join('')}concat=n=${videoLabels.length}:v=1:a=0[vout]`
    );

    // ── 声音：口播 + 配乐，混到一条 ───────────────────────────────────────
    const audioLabels: string[] = [];

    for (const track of project.tracks) {
        if (track.kind !== 'voice') continue;

        track.clips.forEach((clip, index) => {
            const file = assetPathOf(project, clip.assetId);
            const idx = addInput(file, [
                '-ss',
                toSeconds(clip.inMs),
                '-t',
                toSeconds(clip.outMs - clip.inMs)
            ]);

            const label = `a${audioLabels.length}_${index}`;
            filters.push(
                `[${idx}:a]aresample=48000,${volumeArg(clip.gainDb)},` +
                    // `all=1`：不写的话只延迟第一个声道，立体声会错位成回声
                    `adelay=${Math.round(clip.startMs)}:all=1[${label}]`
            );
            audioLabels.push(`[${label}]`);
        });
    }

    for (const track of project.tracks) {
        if (track.kind !== 'music') continue;

        for (const [index, clip] of track.clips.entries()) {
            const asset = project.assets[clip.assetId];
            // **配乐没有文件是常态**：内置曲库只有清单。
            // 这时候跳过它而不是报错——片子照样该出得来，
            // 少一条配乐比"导不出来"好得多
            if (!asset?.absolutePath) continue;

            // 曲子比片子短时循环铺满。`-stream_loop -1` 要放在 `-i` 前面
            const idx = addInput(asset.absolutePath, ['-stream_loop', '-1']);
            const label = `m${index}`;
            filters.push(
                `[${idx}:a]aresample=48000,${volumeArg(clip.gainDb)},` +
                    `atrim=0:${toSeconds(clip.durationMs)},` +
                    `asetpts=PTS-STARTPTS[${label}]`
            );
            audioLabels.push(`[${label}]`);
        }
    }

    if (audioLabels.length === 0) {
        /**
         * 一条音轨都没有时补静音。
         *
         * 不补的话输出就是个纯视频文件——而**多数播放器和剪辑软件会把
         * 没有音轨的 mp4 当成异常**，用户也会以为导出坏了。
         */
        const idx = addInput(
            'anullsrc=channel_layout=stereo:sample_rate=48000',
            ['-f', 'lavfi', '-t', toSeconds(totalMs)]
        );
        filters.push(`[${idx}:a]anull[aout]`);
    } else {
        filters.push(
            `${audioLabels.join('')}amix=inputs=${audioLabels.length}:` +
                // `normalize=0`：不写的话每条输入会被除以路数，
                // 加一条配乐就把口播压小一半
                `duration=longest:normalize=0,` +
                // 先补后截，保证输出**正好**是成片时长：
                // 短了会在片尾丢掉最后一句，长了会拖一段空白
                `apad,atrim=0:${toSeconds(totalMs)},` +
                `asetpts=PTS-STARTPTS[aout]`
        );
    }

    // ── 字幕：软字幕，不烧进画面 ─────────────────────────────────────────
    //
    // **先把输入加完**再写 filter_complex 与 map：字幕是最后才知道要不要加的
    // 那个输入，而 `-map` 必须排在所有 `-i` 后面
    const subtitleIndex = options.subtitlePath
        ? addInput(options.subtitlePath, [])
        : null;

    outputArgs.push('-filter_complex', filters.join(';'));
    outputArgs.push('-map', '[vout]', '-map', '[aout]');

    if (subtitleIndex !== null) {
        outputArgs.push('-map', `${subtitleIndex}:s`, '-c:s', 'mov_text');
    }

    outputArgs.push(
        '-c:v',
        project.render.videoCodec === 'hevc' ? 'libx265' : 'libx264',
        '-preset',
        project.render.preset,
        '-b:v',
        `${project.render.bitrateKbps}k`,
        '-pix_fmt',
        'yuv420p',
        '-r',
        String(fps),
        '-c:a',
        'aac',
        // 流式播放要能边下边播，moov 必须在前面
        '-movflags',
        '+faststart',
        // 兜底：滤镜算出来的长度万一多出几帧，这里一刀切齐
        '-t',
        toSeconds(totalMs),
        options.outPath
    );

    return {
        args: ['-hide_banner', '-y', ...inputArgs, ...outputArgs],
        durationMs: totalMs,
        inputs
    };
}
