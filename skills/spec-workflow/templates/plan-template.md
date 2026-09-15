# 技术方案：[需求名称]

| | |
| --- | --- |
| 编号 | NNN-slug |
| 分支 | `NNN-slug` |
| 规格 | `./spec.md` |
| UI 定稿 | `./design.md`（无界面时填「不适用」） |
| 日期 | YYYY-MM-DD |

## 摘要

[一段话：要解决的核心问题 + 采用的技术路线。让人不读全文也能判断方向对不对]

## 技术上下文

| 项 | 取值 |
| --- | --- |
| 语言 / 运行时 | TypeScript 5.9 / Electron 38 / Node 22 |
| 主要依赖 | [本需求新增或重度依赖的，不抄全量依赖表] |
| 存储 | [无 / electron-store / 文件系统 / 远端] |
| 测试 | Vitest + Testing Library（jsdom） |
| 目标平台 | macOS / Windows 桌面端 |
| 项目类型 | pnpm Monorepo：`apps/desktop`（Electron）+ `apps/server`（Next.js） |
| 性能目标 | [可量化，或「无特殊要求」] |
| 约束 | [必须兼容的既有行为、不能破坏的接口] |

## 宪法门禁

逐条核对 `AGENTS.md` 与相关 skill 的硬约束。**有一条不通过就不能进入 `/spec.tasks`**。

| 约束 | 来源 | 结论 |
| --- | --- | --- |
| 不引入不必要的新依赖 | AGENTS.md 编码原则 | ✅ / ⚠️ 见豁免 |
| 沿用现有结构、命名、风格 | AGENTS.md 编码原则 | |
| 函数组件 + Hooks，禁 class | AGENTS.md 编码原则 | |
| 渲染层用 hash 路由 | magicut-renderer-ui | |
| 新 React 库同步加 dedupe + optimizeDeps | magicut-renderer-ui | |
| 别名 `@/renderer` 两处同步 | magicut-renderer-ui | |
| IPC 走 preload contextBridge + 全局类型 + eslint globals | magicut-electron-bridge | |
| 测试只收 `tests/**`，组件测试需 jsdom | magicut-testing | |
| pnpm hoisted / allowBuilds 不得改动 | magicut-workspace-ops | |
| 不新增绕过 lint/ts/测试的临时规则 | AGENTS.md 自动化验证 | |

### 复杂度豁免

只有在门禁不通过、且确实必须违反时才填。空表就删掉这一节。

| 违反的约束 | 为什么必须 | 评估过的更简方案 | 为什么更简方案不行 |
| --- | --- | --- | --- |

## 架构设计

### 分层与模块边界

[本需求涉及哪几层，依赖方向如何。主进程 ↔ preload ↔ 渲染层的边界要写清]

### 目录结构

只列**本需求新增或修改**的路径，不要抄整棵树。

```
apps/desktop/
├── client/
│   └── xxx.ts              # 新增：主进程 handler
├── renderer/
│   ├── components/xxx/     # 新增：UI 组件
│   └── pages/XxxPage.tsx   # 新增：页面
└── tests/
    └── xxx/                # 新增：测试
```

### 关键设计决策

| 决策 | 选择 | 备选 | 理由 |
| --- | --- | --- | --- |

## 阶段产物

按需产出，不需要的删掉对应行并说明「不适用」。

| 产物 | 何时需要 | 状态 |
| --- | --- | --- |
| `research.md` | 有技术未知需要先调研 | 待产出 / 不适用 |
| `data-model.md` | 有持久化实体或复杂状态 | 待产出 / 不适用 |
| `contracts/` | 有主进程 IPC 或 HTTP 接口 | 待产出 / 不适用 |

## 风险与依赖

| 风险 | 影响 | 应对 |
| --- | --- | --- |

## 验证方案

| 层次 | 手段 | 覆盖的 FR |
| --- | --- | --- |
| 单元 / 组件 | Vitest + Testing Library | FR-001, FR-002 |
| 静态 | `pnpm lint` / `typecheck` / `spellcheck` | 全部 |
| 实跑 | `pnpm ui:shot` 截图比对 / `pnpm start` | FR-003 |
