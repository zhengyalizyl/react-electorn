import type { VideoProject } from '@magicut-react-demo/video-project';

/**
 * 媒体 URL 的形状与解析。**这个文件不许 import electron。**
 *
 * 渲染层要用 `MEDIA_SCHEME` 和 `toMediaUrl` 拼 URL；一旦和 `protocol.handle`
 * 那些主进程 API 放在同一个模块里，`electron` 就会被打进渲染层的包——
 * 构建直接失败（测试是发现不了的，jsdom 里 import 得动）。
 * 所以形状归形状、注册归注册，两个文件。
 *
 * ## 为什么 URL 里是 id 而不是路径
 *
 * 之前是 `magicut-media://file/<编码后的绝对路径>`：渲染层握着真实路径，
 * 主进程再拿一张白名单去比对。那条路有两个问题：
 *
 * 1. **白名单是个会漏的东西**。归一化、分隔符、符号链接，每一处写错都是
 *    "页面上任意一段脚本能读 `~/.ssh/id_rsa`"。安全性靠一串字符串比较撑着。
 * 2. 渲染层根本不需要知道路径。它只想播"这个工程的这个素材"。
 *
 * 现在是 `miaoma-media://project/<工程目录名>/<kind>/<assetId>`：
 * **渲染层连路径都说不出口**，主进程按工程 JSON 把 id 翻译成路径。
 * 越权这件事从"要不要拦"变成了"根本表达不出来"。
 */

export const MEDIA_SCHEME = 'miaoma-media';

/**
 * 素材种类，和工程 schema 里的 `asset.kind` 一一对应。
 *
 * URL 里带上它：请求的种类和资产实际的种类对不上就直接拒——
 * 否则等于让 URL 决定资产是什么，而那本该由工程说了算。
 */
export type MediaKind = 'video' | 'audio' | 'music';

const KINDS = new Set<string>(['video', 'audio', 'music']);

/**
 * 渲染层用的 URL。
 *
 * 三段都可能含空格、中文、`#`、`?`，逐段编码。
 */
export function toMediaUrl(
    projectId: string,
    kind: MediaKind,
    assetId: string
): string {
    return (
        `${MEDIA_SCHEME}://project/${encodeURIComponent(projectId)}` +
        `/${kind}/${encodeURIComponent(assetId)}`
    );
}

export interface MediaRequest {
    projectId: string;
    kind: MediaKind;
    assetId: string;
}

/**
 * 解析 URL。
 *
 * 形状不对一律返回 null——**不猜**。补全一个缺胳膊少腿的请求，
 * 等于替调用方决定它想读什么。
 */
export function parseMediaUrl(rawUrl: string): MediaRequest | null {
    let url: URL;
    try {
        url = new URL(rawUrl);
    } catch {
        return null;
    }
    if (url.protocol !== `${MEDIA_SCHEME}:` || url.host !== 'project') {
        return null;
    }

    const parts = url.pathname.split('/').filter((part) => part !== '');
    if (parts.length !== 3) return null;

    const [projectId, kind, assetId] = parts as [string, string, string];
    if (!KINDS.has(kind)) return null;

    const decodedProject = decodeURIComponent(projectId);
    const decodedAsset = decodeURIComponent(assetId);
    // 目录名里出现分隔符或 `..` 一律拒：那不是"某个工程"，那是在爬目录。
    // loadProject 里还有一道越界校验，这里是第一道
    if (/[\\/]/.test(decodedProject) || decodedProject.includes('..')) {
        return null;
    }
    if (decodedProject === '' || decodedAsset === '') return null;

    return {
        projectId: decodedProject,
        kind: kind as MediaKind,
        assetId: decodedAsset
    };
}

/**
 * 在工程里把 id 翻译成本地路径。
 *
 * `kind` 必须对得上：拿 `video/<配音 id>` 来请求是形状合法但语义错误的，
 * 放行它等于让 URL 决定资产类型，而那本该由工程说了算。
 */
export function resolveAsset(
    project: VideoProject,
    request: MediaRequest
): string | null {
    // 工程里资产 id 是带 brand 的字符串类型；URL 来的是裸 string，
    // 查表前只能断言。查不到就是 null，断言不会放过不存在的 id
    const asset =
        project.assets[request.assetId as keyof typeof project.assets];
    if (!asset) return null;
    if (asset.kind !== request.kind) return null;
    const absolutePath = asset.absolutePath;
    if (typeof absolutePath !== 'string' || absolutePath === '') return null;
    return absolutePath;
}
