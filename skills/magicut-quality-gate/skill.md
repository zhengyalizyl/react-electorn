---
name: magicut-quality-gate
description: 在 magicut-react 完成编码后做验证收尾、或用户要求提交代码时使用。给出按改动范围选择校验命令的决策表、常见失败的修复方式，以及 pnpm commit 提交规范。触发词：验证、跑一下检查、lint 报错、typecheck、spellcheck 失败、提交代码、commit、交付。
---

# magicut-react 验证与提交

> 路径基准：本文档中的相对路径与命令均以仓库内的 `magicut-react/` 目录为准，
> 例如 `apps/desktop/client/main.ts` 实为 `magicut-react/apps/desktop/client/main.ts`，
> 所有 `pnpm` 命令都需在 `magicut-react/` 下执行。


## 先记住两件事

1. **`.husky/pre-commit` 是空文件**——提交前没有任何自动校验，commit 时只有 `commit-msg` 钩子跑 `commitlint`。所以质量校验**必须手动执行**，不能指望钩子兜底。
2. **默认禁止自动执行任何 Git 提交类操作**（commit / push / 建切删分支 / reset / rebase / `checkout --`）。只有用户明确要求时才提交。

## 按改动范围选校验命令

| 改动内容 | 必跑 | 建议补充 |
| --- | --- | --- |
| 任意 TS/TSX 代码 | `pnpm lint`、`pnpm typecheck` | — |
| 新增/修改逻辑 | 上面 + `pnpm test:run` | — |
| 新增文案、标识符、注释 | 上面 + `pnpm spellcheck` | 生词加进 `.cspell/custom-words.txt` |
| 主进程 / preload / forge 配置 | 上面 + `pnpm --filter @magicut-react/desktop exec tsc --noEmit` | `pnpm --filter @magicut-react/desktop package:mac` 验证能打包 |
| 渲染层页面/路由/样式 | 上面 + `pnpm start` 实跑一次 | — |
| 依赖或 workspace 配置 | 重新 `pnpm install` + 上面全部 | `pnpm fix:electron`（若涉及 Electron） |

`pnpm format`（= `prettier --write . && eslint --fix .`）**会改文件**，执行前要确认这属于本次需求允许的变更范围；只想看问题不想改文件就只跑 `pnpm lint`。

所有根命令都是 `pnpm -r --if-present run <script>` 转发，会同时作用于 desktop 和 server。

## 常见失败与处理

| 报错 | 处理 |
| --- | --- |
| `prettier/prettier` error | `pnpm format`，不要手工对齐 |
| `simple-import-sort/imports` | 同上，自动排序 |
| `no-console` | 删掉调试输出；确实需要日志就走主进程统一方案，不要 disable 规则 |
| `react-hooks/exhaustive-deps` warn | 补全依赖或用 `useCallback`/`useRef` 重构，**不要** `// eslint-disable` |
| `no-undef` 命中构建期注入的全局量 | 到 `eslint.config.mjs` 的 `typedTsFiles.languageOptions.globals` 里登记 |
| cspell 报未知单词 | 确认不是拼错后，加到 `.cspell/custom-words.txt`（`cspell.json` 已忽略 `**/*.md` 和 `package.json`） |
| `tsc` 找不到全局类型 | 检查 `apps/desktop/tsconfig.json` 的 `types` 数组和 `include` 是否包含该 d.ts |

**禁止**新增绕过 ESLint / Prettier / TypeScript / 测试的临时规则或忽略项，除非用户明确批准并说明原因。注意 `@typescript-eslint/no-explicit-any` 当前是 `off`，但这不是滥用 `any` 的理由，能写准的类型就写准。

## 提交流程（仅在用户明确要求时）

```bash
pnpm commit    # = git-cz，走 cz-git 交互式提交
```

不要手写 `git commit -m`。commit message 必须过 `commitlint.config.cjs`（`@commitlint/config-conventional` + conventionalcommits parser）。

可用 type：`feat` `fix` `docs` `style` `refactor` `perf` `test` `build` `ci` `chore` `revert`。
配置开启了 `useEmoji`，scope 填组件名或文件名，subject 用祈使句简短描述。

提交前：

1. 先跑完上表对应的校验命令，并在回复中给出结果。
2. **只 stage 本次需求相关文件**。工作区里存在与本次任务无关的改动时必须保留，不得回滚或一并提交。

## 交付回复格式

每次交付必须包含三段：**关键变更**、**验证命令**、**验证结果**。未能验证的项要说明原因，不要用"应该没问题"带过。
