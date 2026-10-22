import path from 'node:path';

import { defineConfig } from 'vitest/config';

// hoisted 布局下有两份 react 实体：仓库根 node_modules/react，以及 .pnpm 虚拟目录里的那份。
// react-dom 走 Node 解析拿到的是根副本，而 apps/desktop 下的源码解析到的是 .pnpm 副本，
// 两者不一致时 useState 会读到 null。dedupe 解决不了（它同样从 apps/desktop 起算），
// 必须显式钉到根副本。
const fromRoot = (pkg: string) =>
    path.resolve(__dirname, '../../node_modules', pkg);

const reactRoot = fromRoot('react');

// 不挂 @vitejs/plugin-react：它只提供 Fast Refresh，测试用不到，
// 且它是 ESM-only，会让 Vitest 2 的 CJS 配置加载失败。
// TSX 由 esbuild 按 tsconfig 的 jsx: react-jsx 直接转换。
export default defineConfig({
    // esbuild 只对 .ts/.tsx 读 tsconfig 的 jsx 选项；.jsx 走的是它自己的默认值
    // （经典运行时 React.createElement），于是第三方的 DotField.jsx 会报
    // "React is not defined"。显式指定 automatic，两种后缀行为一致。
    esbuild: { jsx: 'automatic' },
    resolve: {
        alias: [
            // 路径别名要三处同步：vite.renderer.config.ts、tsconfig.json，以及这里。
            // 漏掉这一处，测试里 import '@/renderer/...' 解析不到。
            {
                find: /^@\/renderer/,
                replacement: path.resolve(__dirname, 'renderer')
            },
            {
                find: /^@\/client/,
                replacement: path.resolve(__dirname, 'client')
            },
            { find: /^react$/, replacement: reactRoot },
            { find: /^react\//, replacement: `${reactRoot}/` },
            // react-router 同样要钉到根副本：它默认从 .pnpm 链解析，
            // 那条链上的 react 是第二份实体，渲染 Router 时 useRef 会读到 null。
            { find: /^react-router$/, replacement: fromRoot('react-router') },
            {
                find: /^react-router-dom$/,
                replacement: fromRoot('react-router-dom')
            }
        ],
        dedupe: ['react', 'react-dom', 'react-router-dom']
    },
    test: {
        globals: true,
        environment: 'jsdom',
        include: ['tests/**/*.test.{ts,tsx}'],
        setupFiles: ['tests/setup.ts'],
        coverage: {
            provider: 'v8',
            reporter: ['text', 'json', 'html']
        }
    }
});
