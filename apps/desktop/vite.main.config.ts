import { copyFileSync, mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';

import type { Plugin } from 'vite';
import { defineConfig } from 'vite';

/**
 * 把 `node-sqlite3-wasm.wasm` 复制到主进程产物旁边。
 *
 * ## 为什么必须复制
 *
 * 打包后的 `main.js` 是 **Vite 把 JS 全部内联进来的一个文件**，但 `.wasm` 不是 JS——
 * 它是运行时用 `readFileSync(__dirname + '/node-sqlite3-wasm.wasm')` 读的二进制。
 * 没有它，主进程一碰索引库就抛 `ENOENT: ...node-sqlite3-wasm.wasm`，
 * 而**构建期一切正常**——这正是它容易漏掉的原因。
 *
 * ## 为什么不改成 external
 *
 * 让它保持 external、运行时从 `node_modules` 解析看着更省事，但在打包后的 app 里
 * 那条路径要跨过 asar 与 pnpm 的 hoisted 布局，多一层不确定。
 * 复制一个 1MB 的文件到产物目录，行为在开发和打包两种形态下完全一致。
 */
function copySqliteWasm(): Plugin {
    const require = createRequire(import.meta.url);

    return {
        name: 'magicut:copy-sqlite-wasm',
        // 每次写完产物都跑：dev 下 Forge 会重建主进程，产物目录会被清掉
        writeBundle(options) {
            // 从包的入口反推同目录下的 wasm，不写死 node_modules 路径——
            // hoisted 布局下它可能在仓库根，也可能在 .pnpm 虚拟目录里
            const entry = require.resolve('node-sqlite3-wasm');
            const source = path.join(
                path.dirname(entry),
                'node-sqlite3-wasm.wasm'
            );
            const outDir = options.dir ?? path.resolve('.vite/build');

            mkdirSync(outDir, { recursive: true });
            copyFileSync(source, path.join(outDir, 'node-sqlite3-wasm.wasm'));
        }
    };
}

export default defineConfig({
    plugins: [copySqliteWasm()]
});
