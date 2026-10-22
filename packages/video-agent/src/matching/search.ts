import type {
    MediaIndexDb,
    SearchFilters,
    SearchHit
} from '@magicut-react-demo/media-index';

/**
 * 素材检索（B5 的前半段）。
 *
 * plan.md §8 定的顺序：**硬过滤 → BM25 排序 → Top-K → LLM 精排**。
 * 这个文件只管前三步，精排在 `rerank.ts`。
 *
 * 分工的理由：检索是**确定性**的，精排不是。把它们混在一起，
 * 「同一输入两次结果稳定」这条就再也测不了——你分不清是检索飘了还是模型飘了。
 */

/**
 * repair 回边带来的额外约束（plan.md §6.1）。
 *
 * 第一轮匹配用不到，但校验失败回流时必须能收紧条件重来，
 * 否则重试就是把同一个不够长的片段再选一遍。
 */
export interface MatchConstraints {
    /** 上一轮被否掉的片段。不排除的话 repair 会反复选中同一个 */
    excludeSegmentIds?: readonly string[];
    /**
     * 本工程里**已经用过**的片段。
     *
     * 只降权不排除——重复镜头有时是合理的（呼应、回扣），
     * 而且素材少时硬排除会直接把候选清空，逼出「没有素材」的假失败。
     * 实跑中出现过四个分镜全选同一个片段，就是因为之前完全没有这个概念。
     */
    usedSegmentIds?: readonly string[];
    minWidth?: number;
    minHeight?: number;
    /** 要不要求素材自带人声 */
    hasAudio?: boolean;
    /** 候选池大小。交给 LLM 精排的上限，直接影响精排成本 */
    topK?: number;
    /**
     * 只在这些素材里挑（用户这次选的文件或目录）。
     *
     * **不限定就是整库**——而库里可能还留着上次索引的别的目录，
     * 那样会给这条片子配上用户根本没选过的画面。
     */
    paths?: readonly string[];
    /**
     * 检索一条都没命中时，把**还没打过标**的片段捞进来（不带查询串，只走硬过滤）。
     *
     * 打标是单独一步、要花钱，所以"索引完但没打标"是常态。未打标的片段
     * `description` 是 NULL，FTS 里只剩文件名，而文件名经常是
     * `1e00bd49-….png` 这种 UUID——**任何查询词都匹配不上**，素材明明在库里
     * 却等于不存在。
     *
     * 放它们进来是安全的：精排本来就是多模态的，会把关键帧发给模型看。
     * 未打标的素材有能力被判断，只是走不到那一步。
     *
     * **已打标却没匹配上的不在此列**——那说明语义层尽职了，把它们塞回候选
     * 只会让模型从一堆无关画面里硬挑一个，比诚实地说"这一镜没素材"更糟。
     */
    includeUntagged?: boolean;
}

export interface SceneSearchInput {
    /** 画面意图。检索的主要依据 */
    visualIntent: string;
    /** 配音文案。作为补充检索词——文案里的名词往往也出现在画面里 */
    script?: string;
    /**
     * 这一镜至少要多长。
     *
     * **由配音真实时长决定**（plan.md §3.1），不是拍脑袋定的。
     * 比它短的素材装不下这段配音，属于硬过滤而不是排序因素。
     */
    minDurationMs: number;
    constraints?: MatchConstraints;
}

export const DEFAULT_TOP_K = 20;

/**
 * 拼检索串。
 *
 * `visualIntent` 重复两遍是**刻意的**：BM25 按词频算分，重复一遍相当于给它加权。
 * 文案里的词是补充线索，不该盖过画面意图本身。
 */
export function buildSearchQuery(input: SceneSearchInput): string {
    const parts = [input.visualIntent, input.visualIntent];
    if (input.script) parts.push(input.script);
    return parts.join(' ');
}

/**
 * 检索候选素材。
 *
 * 返回顺序**完全确定**：BM25 升序，同分按片段 id。
 * 底层 `db.search` 的 `order by` 带了 id tie-break，就是为了这条。
 */
export function searchAssetSegments(
    db: MediaIndexDb,
    input: SceneSearchInput
): SearchHit[] {
    const constraints = input.constraints ?? {};
    const excluded = new Set(constraints.excludeSegmentIds ?? []);
    const topK = constraints.topK ?? DEFAULT_TOP_K;

    const filters: SearchFilters = {
        /**
         * **只要有画面的那两类。**
         *
         * `db.search` 的 `kinds` 不传就是全要，包括音频——而用户的素材目录里
         * 混着配乐、录音是常态，它们同样带文件名进了 FTS。不拦的话
         * `办公室背景音.mp3` 会被选成某一镜的画面，成片那一段是黑的，
         * 而时间轴看着完全正常，只有真看一遍才发现。
         *
         * 图片要留着：**一张图配一镜完全成立**，不是非得有视频。
         */
        kinds: ['video', 'image'],
        minDurationMs: input.minDurationMs,
        ...(constraints.paths !== undefined
            ? { paths: constraints.paths }
            : {}),
        ...(constraints.minWidth !== undefined
            ? { minWidth: constraints.minWidth }
            : {}),
        ...(constraints.minHeight !== undefined
            ? { minHeight: constraints.minHeight }
            : {}),
        ...(constraints.hasAudio !== undefined
            ? { hasAudio: constraints.hasAudio }
            : {}),
        // 多要一些再在内存里排除，避免排除完不够 topK。
        // 在数据库层做排除要拼动态 IN 列表，得不偿失
        limit: topK + excluded.size
    };

    let hits = db.search(buildSearchQuery(input), filters);

    // 语义一条都没捞到 → 把未打标的捞进来让精排看图（见 `includeUntagged`）
    if (hits.length === 0 && constraints.includeUntagged === true) {
        hits = db.search('', { ...filters, untaggedOnly: true });
    }

    const used = new Set(constraints.usedSegmentIds ?? []);
    const remaining = hits.filter((hit) => !excluded.has(hit.segmentId));

    /**
     * 已用过的排到后面。
     *
     * **稳定分区**而不是加权重排：BM25 分值没有可比的量纲，
     * 往上面加一个拍脑袋的惩罚分只会让排序变得不可解释。
     * 分成「没用过」「用过」两段、段内保持原序，行为一眼可推。
     */
    const fresh = remaining.filter((hit) => !used.has(hit.segmentId));
    const reused = remaining.filter((hit) => used.has(hit.segmentId));
    return [...fresh, ...reused].slice(0, topK);
}

/**
 * 语义向量检索——**只留接口，不实现**（plan.md §8）。
 *
 * 3000 条描述的全文检索已经够用；方舟是否提供 embedding 也还没核实（待决 #6）。
 * 留这个签名是为了标明扩展点在哪，等真跑出召回不足的 badcase 再拿真实数据决定要不要补。
 *
 * **故意抛错而不是返回空数组**：静默返回空会让调用方以为"检索到了但没有结果"，
 * 从而掩盖掉"这功能压根没实现"这件事。
 */
// eslint 的 no-unused-vars 不认 `_` 前缀。保留形参是为了让签名表达真实契约——
// 将来实现时不用改调用点
// eslint-disable-next-line @typescript-eslint/no-unused-vars
export function embedAssetText(text: string): never {
    throw new Error(
        'embedAssetText 尚未实现（plan.md §8：先用 FTS5，拿到真实召回 badcase 再决定要不要上向量）'
    );
}
