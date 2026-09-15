---
name: magicut-renderer-ui
description: 在 magicut-react 渲染进程新增页面、路由、React 组件或样式时使用。覆盖 createHashRouter 路由、pages 目录约定、@/renderer 路径别名双处配置、Tailwind CSS v4 用法与组件编码风格。触发词：新增页面、加路由、React 组件、renderer、Tailwind、样式、跳转、hash 路由。
---

# magicut-react 渲染层开发

> 路径基准：本文档中的相对路径与命令均以仓库内的 `magicut-react/` 目录为准，
> 例如 `apps/desktop/client/main.ts` 实为 `magicut-react/apps/desktop/client/main.ts`，
> 所有 `pnpm` 命令都需在 `magicut-react/` 下执行。


## 目录约定

```
apps/desktop/renderer/
├── renderer.tsx      # 入口：createRoot(#root) + StrictMode
├── App.tsx           # 仅挂 RouterProvider
├── index.css         # @import 'tailwindcss' + @layer base
├── router/index.tsx  # createHashRouter 路由表
└── pages/            # 页面组件，一个页面一个文件
```

入口挂载节点是 `#root`（`apps/desktop/index.html`），不是 `#app`。

## 路由：必须用 hash 路由

`renderer/router/index.tsx` 使用 `createHashRouter`。**原因不可忽略**：Electron 打包后页面以 `file://` 协议加载，`createBrowserHistory` 刷新会直接 404。任何时候都不要改成 `createBrowserRouter`。

新增页面：

```tsx
// renderer/pages/EditorPage.tsx
export default function EditorPage() {
    return <main className="editor-page">...</main>;
}
```

```tsx
// renderer/router/index.tsx
import EditorPage from '../pages/EditorPage';

export const router = createHashRouter([
    { path: '/', element: <HomePage /> },
    { path: '/editor', element: <EditorPage /> }
]);
```

页面内跳转用 `react-router-dom` 的 `useNavigate` / `<Link>`，不要操作 `location.href`。

## 路径别名：两处必须同步

别名 `@/renderer` 在**两个文件**里各配了一份，改动时必须同时改：

| 文件 | 配置 |
| --- | --- |
| `apps/desktop/vite.renderer.config.ts` | `resolve.alias['@/renderer']` → 运行时解析 |
| `apps/desktop/tsconfig.json` | `compilerOptions.paths['@/renderer/*']` → 类型解析 |

只改一处的典型症状：`pnpm start` 能跑但 `tsc --noEmit` 报找不到模块，或反过来。

## React 依赖去重：本项目最隐蔽的坑

### 症状

页面**整片白屏**，控制台报：

```
Invalid hook call. Hooks can only be called inside of the body of a function component.
  ... more than one copy of React in the same app
Uncaught TypeError: Cannot read properties of null (reading 'useState')
  at exports.useState (react-router-dom.js?v=xxxxxxxx:960)
  at RouterProvider
```

栈顶落在**第三方 React 库**的预构建产物里（`react-router-dom.js?v=...`）。

### 为什么极难定位

调试时把组件改成 `return <div>test</div>` **会正常显示**，很容易误判成 JSX 写法或返回值的问题。这个对照组是误导性的：

- `<div>` 的 type 是字符串，是**宿主元素**，react-dom 直接 `createElement`，全程不调用组件函数、不碰 hooks dispatcher。
- `RouterProvider` 第一行就调 `useState`，走的是完全不同的代码路径。

所以真正的判据是「**这个组件有没有调用 hooks**」，不是「返回的是 div 还是别的」。

### 根因

`useState` 自己不实现逻辑，只是读 react 模块内的 `ReactSharedInternals.H` 拿 dispatcher。react-dom 渲染前只往**它自己 import 的那份 React** 的白板上写。一旦存在两份 React 模块实例，就是两块互相看不见的白板，第二份的 `H` 恒为 `null` → `null.useState` 崩溃。

本项目触发条件：`node-linker=hoisted` 让 react 落在**仓库根** `node_modules`，跨出了 Vite root（`apps/desktop`）。Vite 预构建时没把它判为"应外置的已优化依赖"，esbuild 就把整份 react 内联进了第三方库的 deps 产物。

因为错误发生在渲染阶段且没有 Error Boundary，React 会**卸载整棵树**，所以表现为白屏而非局部报错。

### 诊断

检查预构建产物里有没有内联 react：

```bash
grep -l "react/cjs/react.development.js" \
  apps/desktop/node_modules/.vite/deps/*.js
```

命中 `react.js` 以外的任何文件（如 `react-router-dom.js`）即确诊。也可对比体积——内联会多出约 60KB。

### 修复

`apps/desktop/vite.renderer.config.ts` 必须保留这两段：

```ts
resolve: {
    alias: { '@/renderer': path.resolve(__dirname, 'renderer') },
    dedupe: ['react', 'react-dom', 'react-router-dom']
},
optimizeDeps: {
    include: ['react', 'react-dom', 'react-dom/client', 'react-router-dom']
}
```

改完必须重建预构建缓存并**重启 dev server**（运行中的 server 还持有旧模块）：

```bash
pnpm --filter @magicut-react/desktop exec vite optimize --force --config vite.renderer.config.ts
```

验证：上面的 `grep` 无命中，且各 deps 产物都从**同一个** `chunk-*.js` 导入 react。

### 预防

**新增任何会调用 hooks 的第三方 React 库**（组件库、状态管理、动画、表单、图表……）都必须同时加进 `dedupe` 和 `optimizeDeps.include`，否则同样的白屏会再现。

### 不要做的事

不要给 `vite.renderer.config.ts` 加 `base: './'`。Forge 的 plugin-vite 在 `getConfig` 里已经注入 `base: './'` 并与用户配置 merge。手动跑 `vite build` 时看到产物 `index.html` 引用绝对路径 `/assets/...` 是**绕过 Forge 的假象**，不是 bug。

## 样式：Tailwind CSS v4

`renderer/index.css` 用的是 v4 语法 `@import 'tailwindcss'`，**没有 `tailwind.config.js`**，插件由 `@tailwindcss/vite` 在 `vite.renderer.config.ts` 注入。

- 不要新建 v3 风格的 `tailwind.config.js` 或写 `@tailwind base/components/utilities`。
- 需要全局基础样式时写进 `index.css` 的 `@layer base`。
- 主题色需要定制时用 v4 的 `@theme` 块，不要退回配置文件方案。

## 组件编码约定（来自 AGENTS.md + eslint.config.mjs）

- 只用函数组件 + Hooks，**禁止 class 组件**。
- 组件文件 `.tsx`，纯逻辑文件 `.ts`；组件**默认导出**，文件名与组件名一致（`HomePage.tsx` → `HomePage`）。
- 不写 `PropTypes`（`react/prop-types` 已关），用 TS 类型。
- 无需 `import React`（`jsx: "react-jsx"` + `jsx-runtime` 规则已开）。
- `no-console` 是 **error**，渲染层不要留 `console.log`。
- `react-hooks/rules-of-hooks` = error，`exhaustive-deps` = warn，不要用 `// eslint-disable` 绕过依赖告警，先想清楚依赖。
- 注释用简体中文、简短，只在代码不自明时写。

## 格式（.prettierrc / .editorconfig）

4 空格缩进、单引号、有分号、**无尾逗号**（`trailingComma: "none"`）、LF 换行、文件末尾留空行。

import 排序由 `simple-import-sort` 强制，分组顺序是：

1. 裸包名 `^\w`（如 `react`）
2. scope 包 `^@\w`（如 `@tailwindcss/vite`）
3. 路径别名 `^@/`
4. 副作用导入（配置里写作 `^\u0000`，如 `import './index.css'`）
5. 上级相对路径 `../`
6. 同级相对路径 `./`

组间空一行。写完直接 `pnpm format` 自动排好，不要手工纠结。

## 验证

```bash
pnpm --filter @magicut-react/desktop exec tsc --noEmit
pnpm lint
pnpm start
```
