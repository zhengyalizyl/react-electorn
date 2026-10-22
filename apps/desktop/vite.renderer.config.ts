import path from 'node:path';

import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

export default defineConfig({
    plugins: [react(), tailwindcss()],
    resolve: {
        alias: {
            '@/renderer': path.resolve(__dirname, 'renderer'),
            // 只用于 IPC 契约的类型引用；运行时不会被打进渲染层产物
            '@/client': path.resolve(__dirname, 'client'),

            /**
             * **工作区的包直接指到源码，绕开 node_modules。**
             *
             * pnpm 把 `packages/*` 软链进了 `node_modules/@magicut-react-demo/`。
             * 只要解析路径经过 `node_modules`，Vite 就把它当第三方依赖：
             * 发 `Cache-Control: immutable`、挂一个 `?v=<hash>` 版本号，
             * 而那个 hash **不跟文件内容走**。
             *
             * 后果是给某个包新加一个导出之后，浏览器拿的还是永久缓存里那份旧的——
             * 报「does not provide an export named 'xxx'」，而源码里明明写了。
             * 更糟的是**重启 dev server 也不一定好**：hash 没变，缓存就还命中。
             *
             * 指到源码之后它就是普通源文件：no-cache、走 HMR、改完立刻生效。
             * 这一类问题从根上没有了，不用再靠「清缓存 + 重启」兜。
             */
            '@magicut-react-demo/video-project': path.resolve(
                __dirname,
                '../../packages/video-project/src/index.ts'
            ),
            '@magicut-react-demo/video-agent/voices': path.resolve(
                __dirname,
                '../../packages/video-agent/src/tts/voices.ts'
            ),
            '@magicut-react-demo/video-agent/custom-voices': path.resolve(
                __dirname,
                '../../packages/video-agent/src/tts/custom-voices.ts'
            )
        },
        // pnpm hoisted 布局下 react 位于仓库根 node_modules，跨层级会让 Vite
        // 把 react 内联进 react-router-dom 的预构建产物，运行时出现两份 React，
        // 表现为 RouterProvider 内 useState 读取 null。必须显式去重。
        dedupe: ['react', 'react-dom', 'react-router-dom', 'lucide-react']
    },
    server: {
        /**
         * 允许读到仓库根。
         *
         * 上面那几个 alias 指向 `apps/desktop` 之外的 `packages/*`，
         * 而 Vite 默认只肯服务项目根以内的文件——不放开的话会直接 403。
         */
        fs: {
            allow: [path.resolve(__dirname, '../..')]
        },
        watch: {
            /**
             * **盯着工作区里的包看。**
             *
             * Vite 的文件监听默认忽略整个 `node_modules`，而 pnpm 把工作区包
             * 软链到了 `node_modules/@magicut-react-demo/*`（指向 `packages/`）。
             * 于是改了 `packages/video-project/src/*.ts` 之后，dev server
             * **根本不知道**——模块图里还是旧的那份，新加的导出看不见，
             * 报成「does not provide an export named 'sceneIndexAt'」。
             *
             * `!` 前缀是 Vite/chokidar 认的"从忽略列表里撤回来"。
             * 只撤自家这几个包，别的依赖照旧不监听（那才是忽略 node_modules 的意义）。
             */
            ignored: ['!**/node_modules/@magicut-react-demo/**']
        }
    },
    optimizeDeps: {
        include: [
            'react',
            'react-dom',
            'react-dom/client',
            'react-router-dom',
            'lucide-react'
        ],
        /**
         * **工作区内的包不要预构建。**
         *
         * 上面的 alias 已经让它们走源码路径了，这里再排一道：
         * 预构建会把它们缓存进 `.vite/deps`，新加的导出要等缓存失效才看得见。
         *
         * 两道一起留着——alias 管解析，exclude 管 optimizer，
         * 少任何一道都可能让某条 import 路径又绕回 node_modules。
         */
        exclude: [
            '@magicut-react-demo/video-project',
            '@magicut-react-demo/video-agent/voices'
        ]
    }
});
