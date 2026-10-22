/**
 * FTS5 的中文分词层。
 *
 * ## 为什么必须有这一层
 *
 * SQLite FTS5 自带的三个分词器对中文都不可用，这是实测结论不是推测：
 *
 * | 分词器 | 查「办公」 | 查「代码」 | 查「会议室」 |
 * |---|---|---|---|
 * | `unicode61`（默认） | 无命中 | 无命中 | 无命中 |
 * | `porter` | 无命中 | 无命中 | 无命中 |
 * | `trigram` | 无命中 | 无命中 | 命中 |
 *
 * `unicode61` 把一整句无空格的中文当成**一个 token**，任何词都查不到；
 * `trigram` 只在查询词 ≥3 字时才有命中。而我们的描述文本由豆包生成、全是中文，
 * 检索词多为「办公」「特写」这类两字词——直接用等于检索功能不存在。
 *
 * ## 解法
 *
 * 用 `Intl.Segmenter`（Node 内置 ICU，**零依赖**）把中文切成词，以空格连接后入库，
 * 查询时用同一个分词器切查询串。入库与查询共用一套切分，是这套方案成立的前提——
 * 两边不一致就会出现"存的是词、查的是字"这种永远对不上的情况。
 *
 * 英文数字照常按空白切，所以中英混排的素材描述能一起工作。
 */

// 复用同一个实例：Segmenter 构造要初始化 ICU 词典，每次新建会很慢
const segmenter = new Intl.Segmenter('zh-CN', { granularity: 'word' });

/** 切词。只保留"像词"的片段，标点和空白被丢掉 */
export function tokenize(text: string): string[] {
    if (!text) return [];
    const out: string[] = [];
    for (const piece of segmenter.segment(text)) {
        if (!piece.isWordLike) continue;
        const token = piece.segment.trim().toLowerCase();
        if (token) out.push(token);
    }
    return out;
}

/** 入库形态：空格连接的 token 串。写进 FTS 列的是这个，不是原文 */
export function toIndexText(...parts: (string | null | undefined)[]): string {
    return parts
        .filter((p): p is string => typeof p === 'string' && p.length > 0)
        .flatMap((p) => tokenize(p))
        .join(' ');
}

/** FTS5 字符串字面量里，双引号靠重复自身转义 */
function quote(token: string): string {
    return `"${token.replace(/"/g, '""')}"`;
}

/**
 * 把自然语言查询编译成 FTS5 的 MATCH 表达式。
 *
 * 用 `OR` 而不是 `AND`：这一层的职责是**召回**，精排交给上层（BM25 排序 + B5 的 LLM 精排）。
 * 用 `AND` 会让"年轻人在电脑前专注工作"这种长查询几乎必然零命中。
 *
 * 每个 token 加 `*` 前缀通配，弥补分词粒度的差异——
 * 库里切出「办公」，查询切出「办公区」时仍能靠前缀对上。
 *
 * 查询里没有任何可用 token 时返回 `null`，调用方应当走"只有硬过滤"的分支，
 * 而不是把空串丢给 MATCH（那是语法错误）。
 */
export function toMatchExpression(query: string): string | null {
    const tokens = [...new Set(tokenize(query))];
    if (tokens.length === 0) return null;
    return tokens.map((t) => `${quote(t)}*`).join(' OR ');
}

/** 文件名里的分隔符不是词的一部分，切词前先换成空格 */
export function normalizeFileName(fileName: string): string {
    return fileName.replace(/\.[^.]+$/, '').replace(/[_\-.+]+/g, ' ');
}
