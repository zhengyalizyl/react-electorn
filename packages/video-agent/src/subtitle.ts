/**
 * 字幕排布（B7，P1 近似方案）。
 *
 * ## 这里做的是近似，而且知道自己在近似
 *
 * 真正准确的做法是拿 TTS 的**词级时间戳**对齐。火山是否返回时间戳尚未确认
 * （plan.md §4.1 的待决 #3），所以 P1 先按字数比例分配。
 *
 * 但**接口按「未来会有 wordTimings」设计**：`layoutSubtitles` 收一个可选的
 * `wordTimings`，有就用真时间戳，没有就退回比例分配。P2 接上时只是给它传参，
 * 调用方与下游一行都不用改。这是为了避免 P2 推倒重来。
 */

/** 词级时间戳。P2 由 TTS 或强制对齐产出 */
export interface WordTiming {
    word: string;
    startMs: number;
    endMs: number;
}

export interface SubtitleLayoutOptions {
    /**
     * 单行最多多少「全角字宽」。半角字符按 0.5 计。
     *
     * 默认 20 —— 口播字幕的常用上限。画面放得下更多，但一行太长观众读不完。
     * 硬上限见 `maxCharsForCanvas`。
     */
    maxCharsPerLine: number;
    /**
     * 一条字幕最短显示多久。短于这个的会并进相邻条。
     * 一闪而过的字幕比没有字幕更难受。
     */
    minDurationMs: number;
}

export const DEFAULT_SUBTITLE_OPTIONS: SubtitleLayoutOptions = {
    maxCharsPerLine: 20,
    minDurationMs: 800
};

export interface SubtitleSegment {
    text: string;
    startMs: number;
    durationMs: number;
}

export interface SubtitleLayoutInput {
    script: string;
    /** 所属分镜的起点与时长。产出的所有段落都落在这个区间内（不变量 5） */
    startMs: number;
    durationMs: number;
    /** 有就用真时间戳；没有就按字数比例分配 */
    wordTimings?: readonly WordTiming[];
    options?: Partial<SubtitleLayoutOptions>;
}

// ── 字宽 ─────────────────────────────────────────────────────────────────

/**
 * 全角判定。CJK、全角标点、假名按 1 个字宽算，其余按 0.5。
 *
 * 不用 `string.length`：「AI 自动挑选」里的 `AI ` 只占一个汉字多一点的宽度，
 * 按字符数算会让中英混排的行短得莫名其妙。
 */
function isFullWidth(codePoint: number): boolean {
    return (
        (codePoint >= 0x1100 && codePoint <= 0x115f) || // 韩文字母
        (codePoint >= 0x2e80 && codePoint <= 0xa4cf) || // CJK 部首 ~ 彝文
        (codePoint >= 0xac00 && codePoint <= 0xd7a3) || // 韩文音节
        (codePoint >= 0xf900 && codePoint <= 0xfaff) || // CJK 兼容表意
        (codePoint >= 0xfe30 && codePoint <= 0xfe6f) || // CJK 兼容形式
        (codePoint >= 0xff00 && codePoint <= 0xff60) || // 全角 ASCII 与标点
        (codePoint >= 0xffe0 && codePoint <= 0xffe6) ||
        (codePoint >= 0x20000 && codePoint <= 0x3fffd) // CJK 扩展 B 及以后
    );
}

/** 文本的显示宽度，单位是「全角字宽」 */
export function displayWidth(text: string): number {
    let width = 0;
    for (const char of text) {
        width += isFullWidth(char.codePointAt(0) ?? 0) ? 1 : 0.5;
    }
    return width;
}

/**
 * 画布放得下的硬上限。超过它字幕会顶出安全区。
 *
 * 这是**上限**不是推荐值：1920 宽、42px 字号算出来是 38 个字，
 * 但一行 38 个字没人读得完，所以默认值取 20。
 */
export function maxCharsForCanvas(
    canvasWidth: number,
    fontSize: number,
    sideMarginRatio = 0.08
): number {
    if (fontSize <= 0) return 0;
    return Math.floor((canvasWidth * (1 - 2 * sideMarginRatio)) / fontSize);
}

// ── 切句 ─────────────────────────────────────────────────────────────────

/** 句末标点：在这里断句最自然，标点跟着前一句走 */
const SENTENCE_END = /[。！？!?…]+/;
/** 次级停顿：句子仍然过长时才在这里切 */
const CLAUSE_END = /[，,、；;：:]+/;

function splitKeepingDelimiter(text: string, pattern: RegExp): string[] {
    const out: string[] = [];
    let buffer = '';
    for (const char of text) {
        buffer += char;
        // 逐字判断而不是用 split：split 会把标点单独甩出来，还得再拼回去
        if (pattern.test(char)) {
            out.push(buffer);
            buffer = '';
        }
    }
    if (buffer) out.push(buffer);
    return out.map((piece) => piece.trim()).filter(Boolean);
}

/** 按宽度硬切。标点都切不开时的最后手段 */
function hardWrap(text: string, maxWidth: number): string[] {
    if (maxWidth <= 0) return [text];
    const out: string[] = [];
    let buffer = '';
    let width = 0;
    for (const char of text) {
        const charWidth = isFullWidth(char.codePointAt(0) ?? 0) ? 1 : 0.5;
        if (width + charWidth > maxWidth && buffer) {
            out.push(buffer);
            buffer = '';
            width = 0;
        }
        buffer += char;
        width += charWidth;
    }
    if (buffer) out.push(buffer);
    return out;
}

/**
 * 文案 → 字幕行。
 *
 * 三级递降：**显式换行 → 句末标点 → 次级停顿 → 硬切**。
 * 每一级只在上一级切完仍然超宽时才动用，尽量在语义边界上断。
 */
export function splitScript(
    script: string,
    options: Partial<SubtitleLayoutOptions> = {}
): string[] {
    const { maxCharsPerLine } = { ...DEFAULT_SUBTITLE_OPTIONS, ...options };

    // 文案里的显式换行是作者的断句意图，优先级最高
    const hardBreaks = script
        .split('\n')
        .map((line) => line.trim())
        .filter(Boolean);

    const out: string[] = [];
    for (const line of hardBreaks) {
        for (const sentence of splitKeepingDelimiter(line, SENTENCE_END)) {
            if (displayWidth(sentence) <= maxCharsPerLine) {
                out.push(sentence);
                continue;
            }
            for (const clause of splitKeepingDelimiter(sentence, CLAUSE_END)) {
                if (displayWidth(clause) <= maxCharsPerLine) {
                    out.push(clause);
                    continue;
                }
                out.push(...hardWrap(clause, maxCharsPerLine));
            }
        }
    }
    return out;
}

// ── 时间分配 ─────────────────────────────────────────────────────────────

/**
 * 按权重把区间切成若干块。
 *
 * **先算累计边界再相减**，不是逐块取整后累加：后者会攒出舍入误差，
 * 最后一块对不上分镜右边界，直接违反不变量 5。
 */
function allocate(
    startMs: number,
    durationMs: number,
    weights: readonly number[]
): { startMs: number; durationMs: number }[] {
    const total = weights.reduce((sum, w) => sum + w, 0);
    if (weights.length === 0) return [];
    if (total <= 0) {
        // 全零权重时平分，别让所有块都挤成零长
        return allocate(
            startMs,
            durationMs,
            weights.map(() => 1)
        );
    }

    const out: { startMs: number; durationMs: number }[] = [];
    let consumed = 0;
    let cursor = startMs;
    for (let i = 0; i < weights.length; i += 1) {
        consumed += weights[i]!;
        const edge =
            i === weights.length - 1
                ? startMs + durationMs // 末块顶到右边界，吸收全部舍入残差
                : startMs + Math.round((durationMs * consumed) / total);
        out.push({ startMs: cursor, durationMs: edge - cursor });
        cursor = edge;
    }
    return out;
}

/** 把过短的段落并进相邻段，直到没有过短的或只剩一段 */
function mergeTooShort(
    lines: readonly string[],
    startMs: number,
    durationMs: number,
    minDurationMs: number
): string[] {
    let current = [...lines];
    // 每轮至少合掉一段，所以循环一定收敛；上界只是防御
    for (let guard = 0; guard < lines.length; guard += 1) {
        if (current.length <= 1) break;
        const blocks = allocate(
            startMs,
            durationMs,
            current.map((line) => Math.max(displayWidth(line), 0.5))
        );
        const shortest = blocks.reduce(
            (best, block, i) =>
                block.durationMs < blocks[best]!.durationMs ? i : best,
            0
        );
        if (blocks[shortest]!.durationMs >= minDurationMs) break;

        // 并到更短的那个邻居上，这样合出来的段不会一下子变得特别长
        const left = shortest > 0 ? blocks[shortest - 1]!.durationMs : Infinity;
        const right =
            shortest < blocks.length - 1
                ? blocks[shortest + 1]!.durationMs
                : Infinity;
        const target = left <= right ? shortest - 1 : shortest;

        const merged = [...current];
        merged.splice(target, 2, `${current[target]!}${current[target + 1]!}`);
        current = merged;
    }
    return current;
}

/** 用词级时间戳给每行定边界 */
function allocateByWordTimings(
    lines: readonly string[],
    startMs: number,
    durationMs: number,
    wordTimings: readonly WordTiming[]
): { startMs: number; durationMs: number }[] | null {
    const endMs = startMs + durationMs;
    // 按顺序消费词，累到本行的字数就收口
    let cursor = 0;
    const edges: number[] = [startMs];

    for (let i = 0; i < lines.length - 1; i += 1) {
        let remaining = displayWidth(lines[i]!);
        let last: WordTiming | undefined;
        while (remaining > 0 && cursor < wordTimings.length) {
            last = wordTimings[cursor]!;
            remaining -= displayWidth(last.word);
            cursor += 1;
        }
        // 词用光了这一行还没念完 → 这组时间戳对不上当前文案，**整组作废**。
        // 只判 `!last` 是不够的：那只挡住"一个词都没有"，
        // 挡不住"只对上了开头两个字"——后者会切出一个 300ms 的首行，
        // 看上去像正常结果，实则完全错位。
        if (!last || remaining > 0) return null;
        edges.push(Math.min(endMs, Math.max(edges[i]!, last.endMs)));
    }
    edges.push(endMs);

    const out: { startMs: number; durationMs: number }[] = [];
    for (let i = 0; i < lines.length; i += 1) {
        out.push({
            startMs: edges[i]!,
            durationMs: edges[i + 1]! - edges[i]!
        });
    }
    return out.every((block) => block.durationMs > 0) ? out : null;
}

/**
 * 主入口：文案 + 分镜区间 → 字幕段落。
 *
 * 产出保证（不变量 5 就靠这三条）：
 * - 首段从 `startMs` 开始，末段在 `startMs + durationMs` 结束
 * - 段落首尾相接、互不重叠
 * - 每段时长为正
 */
export function layoutSubtitles(input: SubtitleLayoutInput): SubtitleSegment[] {
    const options = { ...DEFAULT_SUBTITLE_OPTIONS, ...input.options };
    if (input.durationMs <= 0) return [];

    const raw = splitScript(input.script, options);
    if (raw.length === 0) return [];

    const lines = mergeTooShort(
        raw,
        input.startMs,
        input.durationMs,
        options.minDurationMs
    );

    const blocks =
        (input.wordTimings && input.wordTimings.length > 0
            ? allocateByWordTimings(
                  lines,
                  input.startMs,
                  input.durationMs,
                  input.wordTimings
              )
            : null) ??
        allocate(
            input.startMs,
            input.durationMs,
            lines.map((line) => Math.max(displayWidth(line), 0.5))
        );

    return lines.map((text, i) => ({
        text,
        startMs: blocks[i]!.startMs,
        durationMs: blocks[i]!.durationMs
    }));
}
