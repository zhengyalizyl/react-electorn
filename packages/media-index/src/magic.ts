import { open } from 'node:fs/promises';
import path from 'node:path';

import type { MediaKind } from './types';

/**
 * 扫描的第二轮：魔数深度校验。
 *
 * 第一轮按扩展名快速过滤（见 `scan.ts`），只排掉明显不是素材的文件；
 * 但扩展名是用户可以随手改的——一个 `.txt` 改名成 `.mp4` 照样通过第一轮，
 * 然后在 ffprobe 那里失败、落一行 `failed` 进库、往后每轮扫描都要再看它一眼。
 *
 * 这一轮读文件头的前几个字节，确认它**真的属于这个扩展名所属的容器族**。
 *
 * ## 两条刻意的边界
 *
 * - **只判容器族，不判流构成。** `.mp4` 和 `.m4a` 的文件头完全一样（同是 ISO BMFF
 *   的 `ftyp`），靠魔数分不出"里面有没有视频流"。那是 ffprobe 的活：`probe.ts`
 *   会按真实流构成回填最终的 `kind`，这里给出的只是来自扩展名的初判。
 * - **按扩展名查规则，不做全库嗅探。** 不问"这个文件到底是什么"，只问
 *   "它是不是它自称的那一类"。于是扩展名为 `.mp4` 的 PNG 会被判为不匹配——
 *   这正是"扩展名篡改"要拦的情况，而不是把它当图片悄悄收下。
 */

/** 够覆盖所有规则：最靠后的检查是 RIFF 容器在 offset 8 的 4 个字节 */
const HEADER_BYTES = 16;

/** 一条魔数规则：在 `offset` 处必须出现 `bytes`，或满足 `test` */
interface Signature {
    readonly label: string;
    readonly offset: number;
    readonly bytes?: readonly number[];
    readonly test?: (header: Uint8Array) => boolean;
}

interface MediaRule {
    readonly kind: MediaKind;
    readonly signatures: readonly Signature[];
}

function ascii(text: string): number[] {
    return [...text].map((ch) => ch.charCodeAt(0));
}

function startsWith(
    header: Uint8Array,
    bytes: readonly number[],
    offset: number
): boolean {
    if (header.length < offset + bytes.length) return false;
    return bytes.every((byte, i) => header[offset + i] === byte);
}

// ── 各容器族的头部特征 ────────────────────────────────────────────────────

/**
 * ISO BMFF（mp4 / m4v / m4a / mov）：offset 4 起是第一个 box 的类型。
 *
 * 现代文件都以 `ftyp` 打头，但 QuickTime 早年导出的 `.mov` 可能直接以
 * `moov`/`mdat`/`wide`/`free`/`skip`/`pnot` 开场。老素材库里这类不罕见，
 * 只认 `ftyp` 会把它们全拒掉。
 */
const ISO_BMFF: Signature = {
    label: 'ISO BMFF / QuickTime',
    offset: 4,
    test: (header) =>
        ['ftyp', 'moov', 'mdat', 'wide', 'free', 'skip', 'pnot'].includes(
            String.fromCharCode(...header.subarray(4, 8))
        )
};

/** RIFF 容器（avi / wav / webp）：`RIFF` + 4 字节长度 + 具体类型 */
function riff(type: string): Signature {
    return {
        label: `RIFF/${type}`,
        offset: 0,
        test: (header) =>
            startsWith(header, ascii('RIFF'), 0) &&
            startsWith(header, ascii(type), 8)
    };
}

/** Matroska 家族（mkv / webm）共用 EBML 头，在容器层面分不出也不必分 */
const EBML: Signature = {
    label: 'EBML (Matroska/WebM)',
    offset: 0,
    bytes: [0x1a, 0x45, 0xdf, 0xa3]
};

const ID3: Signature = { label: 'ID3v2', offset: 0, bytes: ascii('ID3') };

/**
 * MPEG 音频帧同步：连续 11 个 1 bit。
 *
 * 不少 `.mp3` 没有 ID3 头，开头直接就是帧；也有文件前面垫了一段 ID3v2。
 * 两种都要认，所以 mp3 的规则里这条和 `ID3` 是并列的。
 */
const MPEG_AUDIO_SYNC: Signature = {
    label: 'MPEG audio frame sync',
    offset: 0,
    test: (header) => header[0] === 0xff && ((header[1] ?? 0) & 0xe0) === 0xe0
};

/** AAC 裸流的 ADTS 帧同步（FF Fx） */
const ADTS: Signature = {
    label: 'ADTS',
    offset: 0,
    test: (header) => header[0] === 0xff && ((header[1] ?? 0) & 0xf6) === 0xf0
};

const JPEG: Signature = {
    label: 'JPEG',
    offset: 0,
    bytes: [0xff, 0xd8, 0xff]
};

/**
 * MPEG-1/2 的三种开场：节目流（PS）、视频基本流（ES）、传输流（TS）。
 *
 * TS 只有 0x47 这一个同步字节可认，单看第一个字节必然偏松。但这一轮的职责
 * 就是"快速排除明显不对的"，收紧到要校验第 188 字节处的同步，得多读一页才换来
 * 一个几乎不出现的误判——不划算。
 */
const MPEG_SYSTEM: readonly Signature[] = [
    { label: 'MPEG PS', offset: 0, bytes: [0x00, 0x00, 0x01, 0xba] },
    { label: 'MPEG ES', offset: 0, bytes: [0x00, 0x00, 0x01, 0xb3] },
    { label: 'MPEG TS', offset: 0, bytes: [0x47] }
];

/**
 * 每个扩展名认哪些头，命中任意一条即通过。
 *
 * 这张表**同时就是扩展名白名单**——第一轮过滤直接查它。两轮用同一份认定，
 * 不会出现"扫描收下了，但没人知道该拿什么魔数校验它"的扩展名。
 */
export const MEDIA_SIGNATURES: ReadonlyMap<string, MediaRule> = new Map<
    string,
    MediaRule
>([
    // ── 视频 ──────────────────────────────────────────────────────────────
    ['.mp4', { kind: 'video', signatures: [ISO_BMFF] }],
    ['.m4v', { kind: 'video', signatures: [ISO_BMFF] }],
    ['.mov', { kind: 'video', signatures: [ISO_BMFF] }],
    ['.mkv', { kind: 'video', signatures: [EBML] }],
    ['.webm', { kind: 'video', signatures: [EBML] }],
    ['.avi', { kind: 'video', signatures: [riff('AVI ')] }],
    [
        '.flv',
        {
            kind: 'video',
            signatures: [
                { label: 'FLV', offset: 0, bytes: [...ascii('FLV'), 0x01] }
            ]
        }
    ],
    ['.mpg', { kind: 'video', signatures: MPEG_SYSTEM }],
    ['.mpeg', { kind: 'video', signatures: MPEG_SYSTEM }],

    // ── 音频 ──────────────────────────────────────────────────────────────
    ['.mp3', { kind: 'audio', signatures: [ID3, MPEG_AUDIO_SYNC] }],
    ['.wav', { kind: 'audio', signatures: [riff('WAVE')] }],
    // .m4a 与 .mp4 同容器。这里只确认容器，是不是纯音频交给 probe 定
    ['.m4a', { kind: 'audio', signatures: [ISO_BMFF] }],
    [
        '.aac',
        {
            kind: 'audio',
            // 裸 AAC 前面垫一段 ID3v2 很常见，所以 ID3 也算数
            signatures: [
                ADTS,
                ID3,
                { label: 'ADIF', offset: 0, bytes: ascii('ADIF') }
            ]
        }
    ],
    [
        '.flac',
        {
            kind: 'audio',
            // 同样可能被 ID3v2 包一层
            signatures: [
                { label: 'fLaC', offset: 0, bytes: ascii('fLaC') },
                ID3
            ]
        }
    ],

    // ── 图片 ──────────────────────────────────────────────────────────────
    ['.jpg', { kind: 'image', signatures: [JPEG] }],
    ['.jpeg', { kind: 'image', signatures: [JPEG] }],
    [
        '.png',
        {
            kind: 'image',
            signatures: [
                {
                    label: 'PNG',
                    offset: 0,
                    bytes: [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]
                }
            ]
        }
    ],
    ['.webp', { kind: 'image', signatures: [riff('WEBP')] }],
    [
        '.bmp',
        {
            kind: 'image',
            signatures: [{ label: 'BMP', offset: 0, bytes: ascii('BM') }]
        }
    ]
]);

function matches(header: Uint8Array, signature: Signature): boolean {
    if (signature.test) return signature.test(header);
    return startsWith(header, signature.bytes ?? [], signature.offset);
}

/** 这个扩展名在不在白名单里；在的话它属于哪一类 */
export function kindForExtension(filePath: string): MediaKind | null {
    const extension = path.extname(filePath).toLowerCase();
    return MEDIA_SIGNATURES.get(extension)?.kind ?? null;
}

/** 校验结论。不匹配时带上原因，调用方可以原样转给事件流 */
export type MagicVerdict =
    | { ok: true; kind: MediaKind }
    | { ok: false; reason: string };

/** 纯函数版校验，便于单测各种畸形头部 */
export function verifyHeader(
    filePath: string,
    header: Uint8Array
): MagicVerdict {
    const extension = path.extname(filePath).toLowerCase();
    const rule = MEDIA_SIGNATURES.get(extension);
    if (!rule) {
        return { ok: false, reason: `扩展名 ${extension} 不在素材白名单内` };
    }

    if (rule.signatures.some((signature) => matches(header, signature))) {
        return { ok: true, kind: rule.kind };
    }
    const expected = rule.signatures.map((s) => s.label).join(' / ');
    return {
        ok: false,
        reason: `文件头与 ${extension} 不符（期望 ${expected}，实到 ${hex(header)}）`
    };
}

function hex(header: Uint8Array): string {
    if (header.length === 0) return '空文件';
    return [...header.subarray(0, 8)]
        .map((b) => b.toString(16).padStart(2, '0'))
        .join(' ');
}

/**
 * 读文件头并校验。
 *
 * 只读前 16 字节：这一轮要在几千个文件上跑一遍，读多少字节直接决定它是
 * "扫描顺手做的事"还是"又一次全盘 IO"。
 */
export async function verifyMagicNumber(
    filePath: string
): Promise<MagicVerdict> {
    let handle;
    try {
        handle = await open(filePath, 'r');
    } catch {
        return { ok: false, reason: '文件打不开' };
    }
    try {
        const buffer = new Uint8Array(HEADER_BYTES);
        const { bytesRead } = await handle.read(buffer, 0, HEADER_BYTES, 0);
        return verifyHeader(filePath, buffer.subarray(0, bytesRead));
    } catch {
        return { ok: false, reason: '文件头读取失败' };
    } finally {
        await handle.close();
    }
}
