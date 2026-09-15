---
description: Pencil UI 定稿——按规格在 .pen 里生成/更新设计稿，产出 design.md
argument-hint: [需求编号，如 002；留空则取最新的]
---

UI 定稿环节。界面在这里收敛，之后不再反复推翻。

先读 `pencil-ui-loop` skill 的 A 段，再按它的要求读 pencil 自带文档
（`mcp__pencil__read_skill()` 与 `execute.md`）——**不要凭记忆写 execute 代码**。

目标需求：$ARGUMENTS（留空则取 `specs/` 下序号最大的）

## 前置检查

- `spec.md` 存在且无 `[NEEDS CLARIFICATION]`。有就先跑 `/spec.clarify`。
- pencil MCP 可用。不可用时明确告诉用户「pencil MCP 未连接」并停下，不要用别的方式凑。
- `get_app_state` 确认当前 `.pen` 文件与已有顶层 frame。

## 两条路径

**设计稿已由设计师定稿**：跳过生成，直接读已有 frame，产出 `design.md`。

**需要 AI 生成**：按 `spec.md` 的用户故事逐屏生成。

## 生成时的要求

1. **先看已有设计**。同一个 `.pen` 里已有的屏幕，其令牌、组件、视觉语言要沿用，
   不要每个需求另起一套。已有可复用组件就实例化，不要重画。

2. **令牌先行**。新增颜色/字体/圆角先 `SetVariables`，节点用 `$token` 引用。

3. **逐块推进**。每完成一个区块 `TakeScreenshot` 自查，不要攒到最后。
   整个过程 frame 挂 `placeholder: true`，完成即取消。

4. **按用户故事组织**。一个 P 级故事对应一屏或一个区块，`design.md` 里要能对上。

## 评审

生成完对整屏 `TakeScreenshot`，逐项自查后**把截图给用户看**并征求意见：

- [ ] 布局没有塌陷、没有内容溢出 frame
- [ ] 文字与背景对比度足够
- [ ] 对齐与间距成体系，不是每块一套
- [ ] 视觉语言与 `.pen` 里已有屏幕一致
- [ ] `spec.md` 的每个 P1/P2/P3 故事都能在设计稿里找到落点

用户提修改意见时**直接改已有节点**，不要删掉重画。

## 产出 design.md

读 `spec-workflow/templates/design-template.md` 按模板填。必须包含：

- **frame id**——实现环节靠它定位，写错整环白做
- 设计令牌与代码 `@theme` 的对应关系
- 各区块的**布局意图**（谁定宽、谁伸缩）与**状态**（有几种态、怎么表现）
- 交互说明（设计稿表达不了，只能写在这里）
- 占位内容清单（哪些文案不是正式的）
- 实现时必须补的无障碍项

## 结束时

汇报：新增/修改了哪些 frame 及其 id、新增了哪些令牌、还有哪些待用户确认的视觉决策。
提示下一步跑 `/spec.plan`。
