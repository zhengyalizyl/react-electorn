---
name: magicut-electron-bridge
description: 在 magicut-react 桌面端新增、修改或调试主进程能力与 window.magicutAPI 的桥接时使用。覆盖 ipcMain/ipcRenderer、preload contextBridge、全局类型声明、ESLint globals 白名单这条完整链路。触发词：IPC、preload、contextBridge、magicutAPI、主进程、渲染进程通信、窗口能力、原生能力。
---

# magicut-react 主进程 ↔ 渲染进程桥接

> 路径基准：本文档中的相对路径与命令均以仓库内的 `magicut-react/` 目录为准，
> 例如 `apps/desktop/client/main.ts` 实为 `magicut-react/apps/desktop/client/main.ts`，
> 所有 `pnpm` 命令都需在 `magicut-react/` 下执行。


## 核心事实

渲染进程**不开启** `nodeIntegration`，只能通过 preload 暴露的 `window.magicutAPI` 访问主进程能力。新增一个能力必须同时改 **4 个地方**，漏掉任何一处都会在 lint / typecheck / 运行时之一失败。

## 四步链路（缺一不可）

### 1. 主进程注册 handler — `apps/desktop/client/main.ts`

```ts
import { app, BrowserWindow, ipcMain } from 'electron';

ipcMain.handle('magicut:read-project', async (_event, projectId: string) => {
    // 返回值必须可结构化克隆，不能返回类实例、函数、Symbol
    return { success: true, data: null };
});
```

约定：

- 通道名统一 `magicut:` 前缀，短横线命名，例如 `magicut:read-project`。
- 返回值统一 `{ success: boolean; ... }` 形状，与现有 `ping` 保持一致。
- 注册时机放在 `app.whenReady()` 之前或之中均可，但不要放进 `createWindow()`，否则 macOS 上 `activate` 重开窗口会重复注册并抛错。

### 2. preload 暴露 — `apps/desktop/client/preload.ts`

```ts
import { contextBridge, ipcRenderer } from 'electron';

contextBridge.exposeInMainWorld('magicutAPI', {
    ping: async () => ({ success: true }),
    readProject: (projectId: string) =>
        ipcRenderer.invoke('magicut:read-project', projectId)
});
```

注意：`exposeInMainWorld` 只能调用一次，新能力要加进**同一个对象字面量**，不要再写第二次 `exposeInMainWorld('magicutAPI', ...)`。

### 3. 全局类型声明 — `apps/desktop/magicut.env.d.ts`

```ts
interface Window {
    magicutAPI: {
        ping: () => Promise<{ success: boolean }>;
        readProject: (
            projectId: string
        ) => Promise<{ success: boolean; data: unknown }>;
    };
}
```

这个文件是通过 `apps/desktop/tsconfig.json` 的 `"types": ["node", "./magicut.env.d.ts"]` 生效的。**如果新增其他全局声明文件，必须同时加进这个 `types` 数组**，否则 `tsc --noEmit` 看不到。

### 4. ESLint 全局白名单 — 根目录 `eslint.config.mjs`

`typedTsFiles` 块的 `languageOptions.globals` 里已注册：

```js
MAIN_WINDOW_VITE_DEV_SERVER_URL: 'readonly',
MAIN_WINDOW_VITE_NAME: 'readonly',
magicutAPI: 'readonly'
```

只要新增了别的构建期注入全局量（例如新增一个 renderer target，Forge 会注入 `XXX_WINDOW_VITE_DEV_SERVER_URL`），必须在此登记，否则 `no-undef`（当前为 `warn`）会报出来。

## 渲染层调用

```tsx
const result = await window.magicutAPI.readProject(projectId);
```

不要在渲染层 `import { ipcRenderer } from 'electron'` —— 打包后会直接报错。

## 主进程窗口加载逻辑

`createWindow()` 中开发态走 `MAIN_WINDOW_VITE_DEV_SERVER_URL`，生产态走
`loadFile(path.join(__dirname, '../renderer/' + MAIN_WINDOW_VITE_NAME + '/index.html'))`。
新增窗口时必须保留这个双分支，并在 `forge.config.ts` 的 `VitePlugin.renderer` 数组里增加同名 target。

## 安全约束（forge.config.ts 的 FusesPlugin）

已关闭 `RunAsNode`、`EnableNodeOptionsEnvironmentVariable`、`EnableNodeCliInspectArguments`，开启 Cookie 加密与 ASAR 完整性校验。**不要为了调试方便关掉这些 fuse 后提交**；临时调试完请恢复。

## 验证

```bash
pnpm --filter @magicut-react/desktop exec tsc --noEmit
pnpm lint
pnpm start          # 实跑一次，确认 IPC 真的通
```
