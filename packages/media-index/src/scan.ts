import { opendir, stat } from 'node:fs/promises';
import path from 'node:path';

import { MEDIA_SIGNATURES, verifyMagicNumber } from './magic';
import type { MediaKind, ScannedFile } from './types';

/**
 * 扫描的扩展名白名单。
 *
 * **直接取自魔数规则表**（`magic.ts`），不另起一份列表：两份清单迟早会漂移，
 * 而漂移的症状是"某个扩展名扫得到却没人知道拿什么魔数校验它"。
 */
export const MEDIA_EXTENSIONS: readonly string[] = [
    ...MEDIA_SIGNATURES.keys()
].sort();

/**
 * 只要某几类的扩展名，**同样取自魔数规则表**。
 *
 * 给文件对话框的过滤器用。界面上另抄一份列表的话，"挑得到的"和"扫得进的"
 * 迟早各走各的——图片就是这么被挡在外面的：管线早就支持，选择器里却是灰的。
 *
 * 带不带前导点由调用方定：Electron 的 `filters.extensions` 要的是不带点的。
 */
export function extensionsOfKind(
    kinds: readonly MediaKind[],
    options: { withDot?: boolean } = {}
): string[] {
    const wanted = new Set(kinds);
    return [...MEDIA_SIGNATURES.entries()]
        .filter(([, rule]) => wanted.has(rule.kind))
        .map(([extension]) =>
            options.withDot === false ? extension.slice(1) : extension
        )
        .sort();
}

export interface ScanOptions {
    /**
     * 收窄白名单，例如只要视频：`['.mp4', '.mov']`。
     *
     * 只能收窄不能放宽——第二轮的魔数校验按扩展名查规则表，
     * 表里没有的扩展名一律判不匹配。
     */
    extensions?: readonly string[];
    signal?: AbortSignal;
    /** 每收下一个文件回调一次，供上层做进度提示 */
    onFound?: (file: ScannedFile) => void;
    /**
     * 过了扩展名、但文件头对不上，被挡在索引外。
     *
     * **一定要报出来**：不报的话用户"挑了 5 个文件，扫出 3 个"而没有任何解释，
     * 比报一个错更难排查。
     */
    onRejected?: (filePath: string, reason: string) => void;
}

function isHidden(name: string): boolean {
    return name.startsWith('.');
}

/**
 * 递归遍历素材，**双层过滤**。
 *
 * 1. **扩展名快速过滤**：只看路径字符串，不碰磁盘，先把明显不是素材的排掉
 * 2. **魔数深度校验**：读前 16 字节确认它真的属于该扩展名的容器族
 *
 * 分两层是为了效率：一个几千文件的素材目录里，绝大多数条目在第一层就被
 * 字符串比较淘汰了，真正发生 IO 的只有候选文件。而第二层不可省——扩展名是
 * 用户随手就能改的，一个 `.txt` 改名成 `.mp4` 会一路走到 ffprobe 才失败，
 * 然后以 `failed` 的身份常驻索引，每轮扫描都要再看它一眼。
 *
 * `roots` 里**既可以是目录也可以是素材文件本身**：界面上用户是在系统对话框里
 * 直接挑文件的（多选），挑出来的就是一串文件路径；命令行则习惯给一个目录。
 * 两种都得认，否则"挑了 5 个文件，扫出 0 个"——还不报错。
 *
 * 三条刻意的取舍：
 * - **跳过符号链接**：目录软链会成环，走进去就出不来了
 * - **跳过点开头的条目**：`.DS_Store`、`.Trash`、`@eaDir` 这类不是素材
 * - **单个目录读失败不中断整轮**：一个权限不足的子目录不该让 3000 个文件白扫
 *
 * 返回值按路径排序，让两次扫描的处理顺序稳定——续跑时更好对照进度。
 */
export async function scanMediaDirectory(
    roots: readonly string[],
    options: ScanOptions = {}
): Promise<ScannedFile[]> {
    const allowed = new Set(
        (options.extensions ?? MEDIA_EXTENSIONS).map((e) => e.toLowerCase())
    );
    const found: ScannedFile[] = [];
    const seen = new Set<string>();

    const addFile = async (full: string): Promise<void> => {
        // ── 第一轮：扩展名 ──
        if (!allowed.has(path.extname(full).toLowerCase())) return;
        if (seen.has(full)) return;
        // 认定过就不再认定第二遍。放在校验之前，是为了让"既被目录扫到又被显式
        // 点名"的文件只产生一次 rejected 回调
        seen.add(full);

        let info;
        try {
            info = await stat(full);
        } catch {
            return;
        }

        // ── 第二轮：魔数 ──
        const verdict = await verifyMagicNumber(full);
        if (!verdict.ok) {
            options.onRejected?.(full, verdict.reason);
            return;
        }

        const file: ScannedFile = {
            path: full,
            sizeBytes: info.size,
            // mtimeMs 是浮点。列是 integer，不取整会出现"存进去 1.7e12，读出来差 0.5"的假变更
            mtimeMs: Math.round(info.mtimeMs),
            kind: verdict.kind
        };
        found.push(file);
        options.onFound?.(file);
    };

    const walk = async (dir: string): Promise<void> => {
        options.signal?.throwIfAborted();

        let entries;
        try {
            entries = await opendir(dir);
        } catch {
            // 读不了就跳过这棵子树，不影响其余目录
            return;
        }

        for await (const entry of entries) {
            options.signal?.throwIfAborted();
            if (isHidden(entry.name)) continue;

            const full = path.join(dir, entry.name);
            if (entry.isSymbolicLink()) continue;

            if (entry.isDirectory()) {
                await walk(full);
                continue;
            }
            if (!entry.isFile()) continue;
            await addFile(full);
        }
    };

    for (const root of roots) {
        options.signal?.throwIfAborted();
        const full = path.resolve(root);

        let info;
        try {
            info = await stat(full);
        } catch {
            // 目录被删了、盘没挂上：跳过这一项，别让其余的白扫
            continue;
        }

        if (info.isDirectory()) {
            await walk(full);
        } else if (info.isFile()) {
            await addFile(full);
        }
    }

    found.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
    return found;
}

/**
 * 增量判据：`size:mtime`。
 *
 * 不用内容哈希——3000 个视频文件跑一遍 sha256 要读几十 GB，
 * 而剪辑素材几乎不会"内容变了但 size 和 mtime 都不变"。
 * 真需要内容级校验的地方（B9 落工程时）单独对选中的十几个文件算。
 */
export function contentKeyOf(file: ScannedFile): string {
    return `${file.sizeBytes}:${file.mtimeMs}`;
}
