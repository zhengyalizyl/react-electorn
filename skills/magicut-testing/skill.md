---
name: magicut-testing
description: 在 magicut-react 写单元测试、补测试覆盖，或要为 React 组件/渲染层加测试时使用。说明当前 Vitest 配置的实际覆盖范围、盲区，以及扩展到组件测试所需的完整改动。触发词：写测试、单测、vitest、测试覆盖率、组件测试、test:run 没跑到我的测试。
---

# magicut-react 测试

> 路径基准：本文档中的相对路径与命令均以仓库内的 `magicut-react/` 目录为准，
> 例如 `apps/desktop/client/main.ts` 实为 `magicut-react/apps/desktop/client/main.ts`，
> 所有 `pnpm` 命令都需在 `magicut-react/` 下执行。


## 当前配置的真实范围（重要盲区）

`apps/desktop/vitest.config.ts`：

```ts
test: {
    globals: true,
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    coverage: { provider: 'v8', reporter: ['text', 'json', 'html'] }
}
```

这意味着：

- **只收 `apps/desktop/tests/` 下的 `.test.ts`**。写在 `renderer/` 或 `client/` 旁边的同目录测试**不会被执行**，`pnpm test:run` 会安静地跳过 —— 这是最容易踩的坑。
- **不收 `.test.tsx`**，且环境是 `node` 不是 `jsdom`，所以现在**跑不了任何 React 组件测试**。
- `apps/server`（Next.js）**没有配置测试**，`pnpm -r` 会因 `--if-present` 直接跳过。

目前 `tests/` 下只有 `smoke.test.ts` 一个占位用例。

## 写纯逻辑测试（当前就能跑）

放在 `apps/desktop/tests/xxx.test.ts`，`globals: true` 所以 `describe/it/expect` 可以不 import（现有 `smoke.test.ts` 仍显式 import，沿用这个显式风格更稳）：

```ts
import { describe, expect, it } from 'vitest';

import { formatDuration } from '../renderer/utils/format';

describe('formatDuration', () => {
    it('把秒数格式化为 mm:ss', () => {
        expect(formatDuration(65)).toBe('01:05');
    });
});
```

命令：

```bash
pnpm test:run                                   # 全仓跑一次
pnpm --filter @magicut-react/desktop test       # watch 模式
pnpm test:coverage                              # v8 覆盖率
```

## 要加 React 组件测试时，必须一次改齐这几处

不要只写测试文件然后疑惑为什么没跑。完整改动：

1. 装依赖：

   ```bash
   pnpm --filter @magicut-react/desktop add -D \
     jsdom @testing-library/react @testing-library/jest-dom @testing-library/user-event
   ```

2. 改 `apps/desktop/vitest.config.ts`：

   ```ts
   import react from '@vitejs/plugin-react';
   import { defineConfig } from 'vitest/config';

   export default defineConfig({
       plugins: [react()],
       test: {
           globals: true,
           environment: 'jsdom',
           include: ['tests/**/*.test.{ts,tsx}'],
           setupFiles: ['tests/setup.ts'],
           coverage: { provider: 'v8', reporter: ['text', 'json', 'html'] }
       }
   });
   ```

   > 注意 `vitest.config.ts` 与 `vite.renderer.config.ts` 是两份独立配置，别名 `@/renderer` **不会自动继承**，组件测试里若用别名导入，需要在 vitest 配置中再加一份 `resolve.alias`。

3. 新建 `apps/desktop/tests/setup.ts`：`import '@testing-library/jest-dom/vitest';`

4. `vitest.config.ts` 已在根 `eslint.config.mjs` 的 `ignoredPaths` 里被 typed 规则排除，但会被 `configFiles` 块接管（仍强制 `prettier/prettier` 和 `no-console`），格式化照常跑 `pnpm format`。

## 测主进程 / IPC 逻辑

`electron` 模块在 Vitest 里不可用。要测 `client/` 下的逻辑：

- 优先把纯逻辑抽成不 import `electron` 的独立模块，直接测那个模块。
- 确需 mock 时用 `vi.mock('electron', () => ({ ipcMain: { handle: vi.fn() }, app: { ... } }))`。
- 端到端的窗口行为不用单测覆盖，靠 `pnpm start` 实跑验证。

## 原则

- 测行为不测实现细节；组件测试查渲染结果和交互，不查内部 state。
- 新增业务逻辑时同步补测试，测试文件名与被测模块同名。
- 不要为了让测试通过而放宽断言或加 `skip`。
