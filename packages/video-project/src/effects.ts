import type { Background, Beauty, ClipEffects, Matting } from './schema';

/**
 * 画面效果的参数换算。**纯函数，没有副作用，不碰磁盘也不碰 WebGL。**
 *
 * ## 为什么所有换算都挤在这一个文件里
 *
 * 同一组滑杆要喂给**两条完全不同的渲染路径**：
 *
 * | | 预览 | 导出 |
 * |---|---|---|
 * | 跑在哪 | 渲染进程，WebGL 着色器 | 主进程，ffmpeg 滤镜 |
 * | 吃什么 | uniform（浮点数） | 滤镜串（`bilateral=sigmaS=…`） |
 *
 * 两边各算各的话，「磨皮拖到 60」在预览里和在成片里就是两个强度——
 * 而这种不一致**没有任何一处会报错**，用户只会觉得"导出之后好像变了"，
 * 却说不清哪里变了。所以两条路都从这里取数：
 * `beautyShader` 和 `beautyFilters` 读的是同一组中间量（`beautyAmounts`）。
 *
 * ## 工程里存的是滑杆位置，不是物理量
 *
 * `smooth: 60` 的意思是"滑杆在 60"，不是"σ=4.2"。存物理量的话，
 * 哪天换一种磨皮算法，所有旧工程的数值就全错了——而界面照样显示得出来，
 * 只是效果对不上。存位置则是把解释权留在这个文件里，换算改了旧工程跟着走。
 */

/** 滑杆位置 0–100 → 0–1。越界一律夹回去，算出 NaN 的滤镜串会让整条导出失败 */
function unit(value: number): number {
    if (!Number.isFinite(value)) return 0;
    return Math.min(1, Math.max(0, value / 100));
}

/**
 * ffmpeg 参数统一保留三位小数。
 *
 * 不收口的话 `0.1 * 3` 会写成 `0.30000000000000004` 进命令行——
 * 能跑，但命令串没法读，出错时对着它排查格外费劲。
 */
function n3(value: number): string {
    return String(Number(value.toFixed(3)));
}

// ── 美颜 ─────────────────────────────────────────────────────────────────

/**
 * 四档滑杆换算出来的中间量。**预览与导出的唯一共同来源。**
 *
 * 取值范围照着 ffmpeg 那几个滤镜定（见各字段），WebGL 那边按同样的语义实现，
 * 所以两条路对同一个滑杆位置给出的是同一个强度。
 */
export interface BeautyAmounts {
    /** `bilateral` 的空间 sigma。0 表示不磨 */
    smoothSigmaS: number;
    /** `bilateral` 的值域 sigma */
    smoothSigmaR: number;
    /** `eq=brightness`，加性，0–1 */
    brightness: number;
    /** `eq=gamma` */
    gamma: number;
    /** `eq=saturation` */
    saturation: number;
    /** `colorbalance=rm`，中间调往红偏多少 */
    redMid: number;
    /** `colorbalance=rh`，高光往红偏多少 */
    redHigh: number;
    /** `colorbalance=bm`，中间调往蓝偏多少（红润时为负） */
    blueMid: number;
    /** `unsharp` 的亮度强度 */
    sharpenAmount: number;
}

/** 四档全是 0 时的中间量：每一项都是"什么都不做" */
const NEUTRAL: BeautyAmounts = {
    smoothSigmaS: 0,
    smoothSigmaR: 0,
    brightness: 0,
    gamma: 1,
    saturation: 1,
    redMid: 0,
    redHigh: 0,
    blueMid: 0,
    sharpenAmount: 0
};

/**
 * 滑杆位置 → 中间量。
 *
 * 几个上限都是**试出来的**，不是算出来的：
 *
 * - 磨皮 `sigmaS` 到 8 就已经是"塑料脸"了，再大只是更糊；
 *   `sigmaR` 压在 0.3 以内，超过之后双边滤波会开始吃掉鼻翼与下颌的边界，
 *   那时候它就不再是"保边"的了。
 * - 美白用 `gamma` 为主、`brightness` 为辅：只加亮度会把高光直接推爆（额头、
 *   鼻尖变成一片死白），而 gamma 抬的是中间调，正好是皮肤所在的区间。
 *   同时略降饱和——皮肤提亮之后不降饱和会发橙。
 * - 红润往红偏的同时往蓝减一点：只加红会显得脏，减蓝才是"血色"。
 * - 锐化 1.2 是 `unsharp` 不出明显白边的上限。
 */
export function beautyAmounts(beauty: Beauty): BeautyAmounts {
    if (!beauty.enabled) return NEUTRAL;

    const smooth = unit(beauty.smooth);
    const whiten = unit(beauty.whiten);
    const rosy = unit(beauty.rosy);
    const sharpen = unit(beauty.sharpen);

    return {
        // 滑杆在 0 时必须是**整数 0**，否则下面会拼出一条什么都不做的滤镜
        smoothSigmaS: smooth === 0 ? 0 : 1 + smooth * 7,
        smoothSigmaR: smooth === 0 ? 0 : 0.05 + smooth * 0.25,
        brightness: whiten * 0.1,
        gamma: 1 + whiten * 0.18,
        saturation: 1 - whiten * 0.08,
        redMid: rosy * 0.18,
        redHigh: rosy * 0.1,
        blueMid: -rosy * 0.06,
        sharpenAmount: sharpen * 1.2
    };
}

/** 四档是不是全在 0（或整体关着）。全是 0 时不该往滤镜链里塞任何东西 */
export function beautyIsNoop(beauty: Beauty): boolean {
    if (!beauty.enabled) return true;
    return (
        unit(beauty.smooth) === 0 &&
        unit(beauty.whiten) === 0 &&
        unit(beauty.rosy) === 0 &&
        unit(beauty.sharpen) === 0
    );
}

/**
 * 美颜 → ffmpeg 滤镜片段。关着或四档全 0 时返回空数组。
 *
 * **顺序是有讲究的**：先磨皮再调色最后锐化。
 * 把锐化排在磨皮前面的话，刚锐出来的细节立刻被磨掉，等于两档互相抵消——
 * 用户会看到"把锐化拉满也没反应"。
 *
 * `planes=1` 让双边滤波只作用在亮度平面：连色度一起磨会让嘴唇、眼影的边缘发虚，
 * 那是"磨花了"而不是"磨皮"。
 */
export function beautyFilters(beauty: Beauty): string[] {
    if (beautyIsNoop(beauty)) return [];

    const a = beautyAmounts(beauty);
    const filters: string[] = [];

    if (a.smoothSigmaS > 0) {
        filters.push(
            `bilateral=sigmaS=${n3(a.smoothSigmaS)}:` +
                `sigmaR=${n3(a.smoothSigmaR)}:planes=1`
        );
    }
    if (a.redMid > 0) {
        filters.push(
            `colorbalance=rm=${n3(a.redMid)}:rh=${n3(a.redHigh)}:` +
                `bm=${n3(a.blueMid)}`
        );
    }
    if (a.brightness > 0) {
        filters.push(
            `eq=brightness=${n3(a.brightness)}:gamma=${n3(a.gamma)}:` +
                `saturation=${n3(a.saturation)}`
        );
    }
    if (a.sharpenAmount > 0) {
        filters.push(`unsharp=5:5:${n3(a.sharpenAmount)}:5:5:0`);
    }

    return filters;
}

// ── 抠图与背景 ───────────────────────────────────────────────────────────

/**
 * 虚化强度（滑杆位置）→ 高斯模糊的 sigma。
 *
 * 上限 40：再大之后画面已经是一片色块，继续加只是更慢。
 * 下限不取 0——滑杆拖到 1 也该看得出一点变化，否则前几格像是坏的。
 */
export function blurSigma(strength: number): number {
    return unit(strength) * 40;
}

/**
 * 羽化半径（像素）→ 模糊蒙版用的 sigma。
 *
 * 除以 3 是高斯的惯例：σ 的三倍大致覆盖可见的扩散范围，
 * 所以"羽化 3 像素"对应 σ=1 才和用户的直觉对得上。
 */
export function featherSigma(featherPx: number): number {
    return Math.max(0, featherPx) / 3;
}

/**
 * 抠图这一档现在到底要不要干活。
 *
 * **开着但背景是"原背景虚化 0 强度"等于没开**——那种情况下跑一遍分割模型、
 * 再把人像原样贴回原背景上，画面一模一样却要付出逐帧推理的代价。
 */
export function mattingIsNoop(matting: Matting): boolean {
    if (!matting.enabled) return true;
    const { background } = matting;
    return background.kind === 'blur' && blurSigma(background.strength) === 0;
}

/**
 * 背景要不要一张本地图。要的话返回它的工程内相对路径。
 *
 * 导出那边据此决定加不加 `-i`，渲染层据此决定要不要请求图片 URL。
 */
export function backgroundImagePath(background: Background): string | null {
    return background.kind === 'image' ? background.path : null;
}

/**
 * 背景 → CSS。预览里纯色与渐变直接交给浏览器画，不必走着色器。
 *
 * 虚化和图片两档返回 null：它们要跟画面逐帧合成，CSS 表达不了。
 */
export function backgroundCss(background: Background): string | null {
    switch (background.kind) {
        case 'color':
            return background.color;
        case 'gradient':
            // 135deg 与导出侧 `gradients` 的默认走向一致（左上 → 右下）
            return `linear-gradient(135deg, ${background.from}, ${background.to})`;
        case 'blur':
        case 'image':
            return null;
    }
}

/**
 * `#RRGGBB` → ffmpeg 认的 `0xRRGGBB`。
 *
 * ffmpeg 也认 `#` 开头，但那个字符在 shell 和 filter_complex 里都要额外操心，
 * 统一换掉省得哪一层漏了转义。
 */
export function toFfmpegColor(hex: string): string {
    return `0x${hex.replace(/^#/, '').toUpperCase()}`;
}

// ── 整体判断 ─────────────────────────────────────────────────────────────

/**
 * 这个片段有没有任何效果真的要生效。
 *
 * 导出与预览都先问这一句：**没开效果的片子，两条渲染路径一个字都不变**。
 * 既省掉逐帧推理，也保证这次改动不会动到现有工程的成片。
 */
export function hasActiveEffects(effects: ClipEffects): boolean {
    return !mattingIsNoop(effects.matting) || !beautyIsNoop(effects.beauty);
}

/**
 * 这个片段要不要逐帧跑分割模型。
 *
 * 抠图当然要；美颜只在**限定皮肤区域**时才要。
 * 关掉 `skinOnly` 的美颜是整帧处理，一帧模型都不用跑。
 */
export function needsSegmentation(effects: ClipEffects): boolean {
    if (!mattingIsNoop(effects.matting)) return true;
    return !beautyIsNoop(effects.beauty) && effects.beauty.skinOnly;
}
