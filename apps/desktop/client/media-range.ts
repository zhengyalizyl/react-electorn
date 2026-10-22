import path from 'node:path';

/**
 * HTTP Range 与 Content-Type 的纯逻辑。
 *
 * **不许 import electron**——同 `media-url.ts` 的理由，这里要能脱离 Electron 单测。
 * 真正碰 `protocol.handle` 的是 `media-protocol.ts`。
 *
 * ## 为什么必须支持 Range
 *
 * 预览里 `<video>` 的定位是 `el.currentTime = x`（见 `PreviewPanel`），而 **seek
 * 是靠字节 Range 请求完成的**。源不支持 Range 时，只有"整份文件已经缓冲完"才跳得动：
 * 于是大文件、刚打开、磁盘慢的时候画面是黑的，而口播是另一个 `<audio>` 元素，照常响。
 *
 * 用户看到的就是**「有时候画面无法播放，只能出现声音」**——而且这种失败
 * **不触发 `error` 事件**，PreviewPanel 那个"把素材 id 摆到画面上"的兜底也救不了它。
 */

/** 区间两端都是**闭**的，与 HTTP 语义一致：`bytes=0-499` 是前 500 个字节 */
export interface ByteRange {
    start: number;
    end: number;
}

/**
 * 解析 `Range` 头。
 *
 * 三种返回：
 * - `null`——没要求范围，或者形状我们不支持 → 给整份（200）
 * - `ByteRange`——给这一段（206）
 * - `'unsatisfiable'`——start 越界 → 416
 *
 * **认不出来的形状一律当整份，不猜。** 多段 Range（`bytes=0-99,200-299`）
 * 规范允许但我们不实现，给整份是安全的；猜着切一段给出去，播放器会按它
 * 以为的偏移去解析，错得更隐蔽。
 */
export function parseRangeHeader(
    header: string | null | undefined,
    sizeBytes: number
): ByteRange | 'unsatisfiable' | null {
    if (!header) return null;

    const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
    if (!match) return null;

    const rawStart = match[1]!;
    const rawEnd = match[2]!;
    // `bytes=-` 两端都空，无从解释
    if (rawStart === '' && rawEnd === '') return null;

    if (sizeBytes <= 0) return 'unsatisfiable';

    // `bytes=-500` 是**最后 500 个字节**，不是前 500 个。
    // 搞反会让 moov 在尾部的 mp4 读不出元数据，表现成"能听不能看"
    if (rawStart === '') {
        const wanted = Number(rawEnd);
        if (!Number.isFinite(wanted) || wanted <= 0) return null;
        return { start: Math.max(0, sizeBytes - wanted), end: sizeBytes - 1 };
    }

    const start = Number(rawStart);
    if (!Number.isFinite(start)) return null;
    // start 越界必须回 416，**不能悄悄夹回去**——夹了的话播放器以为拿到了
    // 自己要的那一段，然后按错位的字节解析
    if (start >= sizeBytes) return 'unsatisfiable';

    // end 超出则夹到末尾，这是规范允许的
    const end =
        rawEnd === '' ? sizeBytes - 1 : Math.min(Number(rawEnd), sizeBytes - 1);
    if (!Number.isFinite(end) || end < start) return null;

    return { start, end };
}

/**
 * 按扩展名给 Content-Type。
 *
 * 只覆盖预览真会播的那些。**认不出来的给 `application/octet-stream`，不猜成
 * `video/mp4`**——猜错会让 Chromium 按错误的容器去解，报出来的错和真实原因
 * 差着十万八千里。
 */
const CONTENT_TYPES: ReadonlyMap<string, string> = new Map([
    ['.mp4', 'video/mp4'],
    ['.m4v', 'video/mp4'],
    ['.mov', 'video/quicktime'],
    ['.webm', 'video/webm'],
    ['.mkv', 'video/x-matroska'],
    ['.avi', 'video/x-msvideo'],
    ['.mp3', 'audio/mpeg'],
    ['.m4a', 'audio/mp4'],
    ['.wav', 'audio/wav'],
    ['.aac', 'audio/aac'],
    ['.flac', 'audio/flac'],
    ['.jpg', 'image/jpeg'],
    ['.jpeg', 'image/jpeg'],
    ['.png', 'image/png'],
    ['.webp', 'image/webp'],
    ['.bmp', 'image/bmp']
]);

export function contentTypeOf(filePath: string): string {
    return (
        CONTENT_TYPES.get(path.extname(filePath).toLowerCase()) ??
        'application/octet-stream'
    );
}
