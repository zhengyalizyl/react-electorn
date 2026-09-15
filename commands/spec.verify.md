---
description: 验证收尾——按改动范围跑齐校验并修复，回填 spec 产物状态
argument-hint: [需求编号，如 002；留空则取最新的]
---

闭环的最后一环。跑齐该跑的校验，修掉暴露的问题，回填产物状态。

先读 `magicut-quality-gate` skill（按改动范围选命令的决策表在那里）。

目标需求：$ARGUMENTS（留空则取 `specs/` 下序号最大的）

## 步骤

1. **看改动范围**（`git status` / `git diff --stat`），据此选校验命令：

   | 改了 | 至少要跑 |
   | --- | --- |
   | 任意 `.ts` / `.tsx` | `typecheck` + `lint` + `test:run` |
   | 渲染层组件 / 样式 | 再加 `ui:shot` 实跑截图 |
   | 主进程 / preload | 再加 `pnpm start` 实跑 |
   | 新增文案 / 标识符 | 再加 `spellcheck` |
   | 依赖 / 构建配置 | 再加 `package:mac` |

   ```bash
   pnpm --filter @magicut-react/desktop exec tsc --noEmit
   pnpm lint
   pnpm test:run
   pnpm spellcheck
   ```

2. **修掉失败**。不放宽断言、不加 skip、不加绕过规则。
   本机 `pnpm spellcheck` 若因 Node 版本报 `Unsupported NodeJS version`，
   属于环境问题，用更高版本的 node 直接跑 `node <root>/node_modules/cspell/bin.mjs lint ...` 绕过，
   并在汇报里说明这是环境限制而非本次改动的问题。

3. **跑 `pnpm format`** 前先确认格式化属于本次允许的变更范围（AGENTS.md 要求）。

4. **回填产物状态**：
   - `tasks.md`：所有已完成任务勾掉；没做的写明为什么
   - `spec.md`：状态改为「已定稿」
   - 实现过程中发现规格/方案有误的，回改对应文件——**产物必须与代码一致**，
     不一致的规格比没有规格更糟

5. **验收标准逐条走**。`spec.md` 里每条 Given/When/Then 都要有明确结论：
   通过 / 未通过 / 本次不覆盖（写明原因）。

## 结束时

按 AGENTS.md 的交付要求汇报：

- **关键变更**：改了什么，为什么
- **验证命令**：实际跑了哪些
- **验证结果**：逐条结果，失败的说清楚
- **验收标准**：逐条结论
- **未完成项**：有就明确列出，不要含糊

不执行任何 Git 操作。用户要提交时提示走 `pnpm commit`。
