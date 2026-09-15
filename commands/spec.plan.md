---
description: 产出技术方案 plan.md（含宪法门禁），必要时附 research/data-model/contracts
argument-hint: [需求编号，如 002；留空则取最新的]
---

规格的第三层：技术方案。这一层直接决定 AI 生成代码的结构一致性与质量下限。

先读 `spec-workflow` skill 的「项目宪法就是 AGENTS.md」与「规格的三个层级」。

目标需求：$ARGUMENTS（留空则取 `specs/` 下序号最大的）

## 前置检查

- `spec.md` 存在且无 `[NEEDS CLARIFICATION]`
- 有界面的需求，`design.md` 存在且含 frame id

## 步骤

1. **读依据**：`spec.md`、`design.md`（若有）、`AGENTS.md`。

2. **读代码**。方案必须建立在既有实现之上，不是凭空设计：
   - 相关的既有模块、目录结构、命名风格
   - 会被改动的文件当前是什么样
   - 有没有已存在的能力可以复用（**优先复用，不要新造**）

3. **按需读 skill**，只读与本需求相关的：

   | 涉及 | 读 |
   | --- | --- |
   | 主进程 / IPC / preload | `magicut-electron-bridge` |
   | 页面 / 路由 / 组件 / 样式 | `magicut-renderer-ui` |
   | 依赖 / 打包 / workspace | `magicut-workspace-ops` |
   | 测试 | `magicut-testing` |
   | 设计稿转代码 | `pencil-ui-loop` B 段 |

4. **写 plan.md**：读 `spec-workflow/templates/plan-template.md` 按模板填。

5. **跑宪法门禁**。模板里那张表逐条核对，**不许留空、不许写"应该没问题"**。
   有一条不通过就不能进入 `/spec.tasks`，两个出路：
   - 改方案绕过约束
   - 在「复杂度豁免」表里写明为什么必须违反、评估过的更简方案为什么不行

6. **按需产出附属文件**，不需要的在模板表里标「不适用」并删掉对应文件：
   - `research.md`：有技术未知时先调研。每条结论要写清依据与备选。
   - `data-model.md`：有持久化实体或复杂状态时。写字段、类型、约束、关系。
   - `contracts/`：有 IPC 通道或 HTTP 接口时。写通道名、入参、返回、错误码。
     IPC 契约必须同时覆盖 `ipcMain.handle` 签名、preload 暴露形态、全局类型声明。

## 质量自检

- [ ] 摘要一段话能说清方向
- [ ] 目录结构只列本需求动到的路径，没有抄整棵树
- [ ] 每个关键决策都有备选与理由，不是只写了结论
- [ ] 宪法门禁逐条有结论
- [ ] 验证方案覆盖了 `spec.md` 的每一条 FR
- [ ] 没有引入 `AGENTS.md` 意义上「不必要的新依赖」——引入了就要在豁免表里论证

## 结束时

汇报：技术路线一句话、新增依赖（若有）及理由、门禁结论、产出了哪些附属文件。
提示下一步跑 `/spec.tasks`。
