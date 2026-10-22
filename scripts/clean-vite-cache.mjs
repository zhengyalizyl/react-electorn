import { rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * 清掉 Vite 的缓存目录。
 *
 * ## 为什么需要这个脚本
 *
 * 这个仓库是 pnpm workspace，`packages/*` 被软链进
 * `node_modules/@magicut-react-demo/*`。给某个包**新加一个导出**之后，
 * 已经跑着的 dev server 未必跟得上——浏览器那头会报
 * 「does not provide an export named 'xxx'」，而源码里明明写了。
 *
 * `vite.renderer.config.ts` 已经把工作区包排除出预构建、也把它们加进了监听，
 * 但那只对**服务启动之后**的改动有效。服务起在改动之前的话，
 * 它的模块图从一开始就是旧的。
 *
 * 这种时候唯一可靠的动作是：清缓存 + 重启。与其每次去记那几个路径，
 * 不如给它一个名字。
 *
 * ## 只删缓存，**不碰构建产物**
 *
 * 下面每一条都是依赖优化器的缓存（`node_modules/.vite`），删了下次启动自动重建。
 *
 * ⚠️ **`apps/desktop/.vite` 不在这个名单里，尽管它看起来也像缓存。**
 * Electron Forge 的 Vite 插件把主进程和 preload 的构建产物写在
 * `apps/desktop/.vite/build/` 下（`main.js` / `preload.js`）。删掉它，
 * 正在跑的应用会立刻报
 * 「Unable to load preload script: .../.vite/build/preload.js」——
 * 窗口还在，但渲染层和主进程之间的桥没了，`window.magicutAPI` 整个消失。
 *
 * 它确实能靠重新 `pnpm start` 重建，但那是**把一个本来只是清缓存的动作
 * 变成了必须重启**。名字像缓存不等于是缓存。
 */

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');

const targets = [
    // 注意：这里**没有** 'apps/desktop/.vite'——那是 Forge 的构建产物，不是缓存
    'apps/desktop/node_modules/.vite',
    'packages/video-project/node_modules/.vite',
    'packages/video-agent/node_modules/.vite',
    'packages/media-index/node_modules/.vite',
    'node_modules/.vite'
];

let removed = 0;
for (const target of targets) {
    const full = path.join(root, target);
    try {
        await rm(full, { recursive: true, force: true });
        removed += 1;
    } catch (error) {
        // 删不掉不该让整条命令失败：多半是本来就不存在，
        // 真有权限问题也应该继续清剩下的
        console.warn(
            `跳过 ${target}：${error instanceof Error ? error.message : error}`
        );
    }
}

console.log(`已清理 ${removed} 个 Vite 缓存目录，重新启动即可。`);
