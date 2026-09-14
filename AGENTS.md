# AGENTS.md

## 全局高优先级约束

本文件是当前工程的协作规范。所有 Agent 在本仓库内工作时必须优先遵守本文件；若与通用习惯冲突，以本文件为准。

## 语言与沟通

- 始终使用简体中文回复。
- 说明要简洁、专业、面向有经验的开发者。
- 遇到不确定事项时，优先通过读取代码、配置、文档和命令输出确认事实；只有无法从项目中确认时才提问。
- 交付结果必须包含关键变更、验证命令和验证结果；未能验证时必须说明原因。

## Git 与提交约束

- 默认禁止自动执行任何 Git 提交相关操作。
- 未经用户明确要求，不得执行：
  - `git commit`
  - `git push`
  - 创建、切换、删除分支
  - `git reset`
  - `git rebase`
  - `git checkout --`
  - 任何可能覆盖用户改动的命令
- 如果用户明确要求提交代码：
  - 必须使用 `pnpm commit` 完成提交。
  - 提交信息必须符合 `commitlint.config.cjs`。
  - 提交前必须先运行必要验证，并在回复中说明结果。
- 工作区中出现非本次任务产生的改动时，必须保留，不得回滚；只处理当前需求相关文件。

## 需求拆解与执行方式

- 每个需求都尽量使用 superpowers 方法论进行：
  - 明确目标和成功标准
  - 拆解任务
  - 识别风险与依赖
  - 制定验证方案
- 如果 `using-superpowers` 或同类 superpowers skill 可用，必须优先读取并使用。
- 对复杂需求，优先考虑使用子智能体并行完成：
  - 代码探索
  - 方案对比
  - 测试设计
  - 风险审查
- 主 Agent 必须负责最终整合、代码一致性检查和验证结果汇总。
- 简单明确的小改动可以直接执行，但仍需先理解相关上下文。

## Skill 使用规范

- 本项目的专属 skill 位于仓库根目录 `../.claude/skills/`（即 `miaoma-magicut-1-notes/.claude/skills/`），优先级高于通用 skill：

  | Skill | 适用场景 |
  | --- | --- |
  | `magicut-electron-bridge` | 主进程能力、IPC、preload、`window.magicutAPI` |
  | `magicut-renderer-ui` | 渲染层页面、路由、React 组件、Tailwind 样式 |
  | `magicut-workspace-ops` | 依赖安装、子包命令、打包、Electron 安装排障 |
  | `magicut-quality-gate` | 编码后的验证收尾与提交 |
  | `magicut-testing` | 写单测、扩展测试配置 |

- 本项目的专属子智能体位于 `../.claude/agents/`：

  | Agent | 适用场景 |
  | --- | --- |
  | `magicut-init` | 从零搭建同构新工程、已有仓库首次环境准备 |
  | `magicut-feature` | 端到端实现一个桌面端功能 |
  | `magicut-reviewer` | 只读审查改动是否合规 |
  | `magicut-verifier` | 验证收尾：跑校验并修复 |
  | `magicut-doctor` | 环境、依赖、构建、打包故障排查 |

- 当任务涉及以下领域时，必须优先匹配并读取对应 `SKILL.md`：
  - React/React 19：`react`、`react-best-practices`
  - React Router：`react-router-best-practices`
  - React 测试：`react-testing-best-practices`、`testing-library`
  - TypeScript：`typescript-best-practices`、`typescript-pro`、`typescript-advanced-types`
  - Electron：`electron-best-practices`、`electron-development`、`electron-dev`
  - Electron Forge：`electron-forge`
  - pnpm/Monorepo：`pnpm`、`shared-monorepo-pnpm-workspaces`
  - Vite/Vitest：`vite`、`vitest`
- 使用 skill 时必须遵循渐进披露：只读取与当前任务直接相关的 skill 和引用文件，不加载无关内容。

## 编码原则

- 严格遵循 SOLID、KISS、DRY、YAGNI。
- 优先沿用现有项目结构、命名、风格和工具链。
- 先读后写；改动必须聚焦当前需求，避免无关重构。
- 不引入不必要的新依赖、抽象或架构层。
- React 组件使用函数组件 + Hooks，禁止 class 组件。
- 组件文件使用 `.tsx`，纯逻辑文件使用 `.ts`；组件默认导出，文件名与组件名保持一致。
- 注释必须与现有代码库语言风格一致；只在代码不自明时添加简短注释。
- 路径处理时优先使用双引号包裹路径，优先使用 `/` 作为路径分隔符。

## 自动化验证

- 编码后应根据影响范围运行当前项目已有验证命令：
  - `pnpm lint`
  - `pnpm format`
  - `pnpm typecheck`
  - `pnpm test:run`
  - `pnpm spellcheck`
- Electron 相关改动可补充运行：
  - `pnpm --filter @magicut-react/desktop package:mac`
  - `pnpm --filter @magicut-react/desktop exec tsc --noEmit`
- 提交相关校验必须遵循 `commitlint.config.cjs`。
- 不得新增绕过 ESLint、Prettier、TypeScript 或测试的临时规则，除非用户明确批准并说明原因。
- 如果验证命令会修改文件，例如 `pnpm format`，必须在执行前确认这是本次需求允许的变更范围。

## 高风险操作确认

执行以下操作前必须获得用户明确确认：

- 删除文件或目录
- 批量移动、批量重命名或批量改写文件
- 修改系统配置、环境变量、权限
- 数据库删除、结构变更、批量更新
- 调用生产环境 API 或发送敏感数据
- 全局安装、卸载或升级包
- Git 重写历史、重置、强推

确认格式：

```text
危险操作检测
操作类型：[具体操作]
影响范围：[详细说明]
风险评估：[潜在后果]

请确认是否继续？需要明确回复“是 / 确认 / 继续”。
```

## 工程上下文

- 当前项目是 pnpm Monorepo。
- 桌面端使用 Electron Forge + Vite + React 19 + TypeScript。
- 服务端保留 Next.js 应用。
- 渲染进程使用 React Router 的 hash 路由（`createHashRouter`），因为打包后页面以 `file://` 加载。
- Electron 安装异常可使用：
  - `pnpm fix:electron`
