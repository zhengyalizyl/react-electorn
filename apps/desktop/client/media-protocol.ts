import { protocol } from 'electron';
import { createReadStream, existsSync, statSync } from 'node:fs';
import { Readable } from 'node:stream';

import type { VideoProject } from '@magicut-react-demo/video-project';

import { contentTypeOf, parseRangeHeader } from './media-range';
import { MEDIA_SCHEME, parseMediaUrl, resolveAsset } from './media-url';

/**
 * 把媒体 scheme 注册到 Electron。
 *
 * URL 的形状与解析在 `media-url.ts`——那边不许 import electron，
 * 因为渲染层也要用它拼 URL（见那个文件开头的说明）。
 *
 * ## 为什么不用 `file://`
 *
 * 开发时渲染层从 `http://localhost` 加载，`file://` 会被同源策略挡下；
 * 打包后页面本身才是 `file://`——**两种形态行为不同的东西迟早出事**。
 * 自定义 scheme 让两种形态走同一条路。
 */

/**
 * scheme 的特权声明。
 *
 * - `standard`：URL 才会被按 `scheme://host/path` 解析，
 *   否则 `new URL()` 拿不到 host，路由就无从谈起
 * - `secure`：算作安全来源，不会被当成混合内容拦下
 * - `stream`：`<video>` 需要它才拿得到流式响应
 * - `supportFetchAPI`：渲染层里 `fetch()` 也能用同一条路
 */
export function registerMediaSchemePrivileges(): void {
    protocol.registerSchemesAsPrivileged([
        {
            scheme: MEDIA_SCHEME,
            privileges: {
                standard: true,
                secure: true,
                supportFetchAPI: true,
                stream: true,
                bypassCSP: true
            }
        }
    ]);
}

export interface MediaProtocolOptions {
    /**
     * 按目录名读一个工程。
     *
     * 传函数而不是传一份快照：工程会被改写（记一条要求、重跑一段），
     * 快照会让预览播到已经不存在的素材上。
     */
    loadProject: (projectId: string) => Promise<VideoProject>;
}

export function registerMediaProtocol(options: MediaProtocolOptions): void {
    protocol.handle(MEDIA_SCHEME, async (request) => {
        // 所有失败都回同一个 404：区分"工程不存在 / 资产不存在 / 文件不在了"
        // 等于把工程结构告诉调用方，而那是它本来就不该知道的
        const notFound = (): Response =>
            new Response('not found', { status: 404 });

        const parsed = parseMediaUrl(request.url);
        if (!parsed) return notFound();

        let project: VideoProject;
        try {
            project = await options.loadProject(parsed.projectId);
        } catch {
            return notFound();
        }

        const filePath = resolveAsset(project, parsed);
        if (filePath === null || !existsSync(filePath)) return notFound();

        /**
         * 自己读 fd 切片，**不走 `net.fetch`**。
         *
         * `net.fetch` 不认 Range：实测（Electron 38）带 `Range: bytes=0-1023`
         * 请求一个 1.6MB 的 mp4，拿回的是 200 和整份文件，没有 `accept-ranges`
         * 也没有 `content-range`。
         *
         * 那样做的代价不是"慢一点"，是**画面干脆不出来**：预览里
         * `<video>` 的定位是 `el.currentTime = x`（见 `PreviewPanel`），
         * 而 seek 靠 Range 完成。不支持 Range 时只有整份缓冲完才跳得动，
         * 于是大文件、刚打开的时候画面黑着，口播（另一个 `<audio>`）照常响——
         * 就是用户说的「有时候画面无法播放，只能出现声音」。
         * 这种失败还**不触发 `error` 事件**，连报错都没有。
         */
        let size: number;
        try {
            size = statSync(filePath).size;
        } catch {
            return notFound();
        }

        const type = contentTypeOf(filePath);
        const range = parseRangeHeader(request.headers.get('range'), size);

        // start 越界要如实回 416。夹回去的话播放器以为拿到了自己要的那段，
        // 然后按错位的字节去解析——错得比报错更隐蔽
        if (range === 'unsatisfiable') {
            return new Response(null, {
                status: 416,
                headers: { 'content-range': `bytes */${size}` }
            });
        }

        const { start, end } = range ?? {
            start: 0,
            end: Math.max(0, size - 1)
        };
        const body = Readable.toWeb(
            createReadStream(filePath, { start, end })
        ) as ReadableStream<Uint8Array>;

        return new Response(body, {
            status: range ? 206 : 200,
            headers: {
                'content-type': type,
                'content-length': String(size === 0 ? 0 : end - start + 1),
                // **这一条即使在 200 上也要给**：播放器靠它判断"这个源能不能跳"，
                // 不给的话它压根不会尝试发 Range 请求
                'accept-ranges': 'bytes',
                ...(range
                    ? { 'content-range': `bytes ${start}-${end}/${size}` }
                    : {})
            }
        });
    });
}
