---
name: spec-workflow
description: 本团队的 Spec Driven 开发闭环——从需求拆解、Pencil UI 定稿、规格编写、任务规划，到实现与验证收尾的完整链路与产物规范。在执行任何 /spec.* 命令时使用；在用户说"写个规格 / 开个新需求 / 拆任务 / 按 spec 开发 / 这个需求怎么落地"时也使用。触发词：spec、规格、需求拆解、spec kit、specify、plan、tasks、闭环、流程。
---

# Spec Driven 开发闭环

> 路径基准：本文档的相对路径以**目标项目根目录**为准（当前主要是 `magicut-react/`）。
> 命令与流程本身与项目无关，同一套可用于 `todo/`、`tido/` 等其他工程。

## 为什么是这套流程

Vibe Coding 解决 0→1，Spec Driven 解决 1→N。AI 代码质量的上限由模型决定，**下限由规格决定**。
这条链路的目的，是把"需求清单 / UI 稿 / 规格"三份结构化产物，变成 AI 的稳定上下文——
上下文越结构化，实现与联调阶段的返工越少。

## 主链路

```
/spec.constitution   项目宪法（一次性，之后按需维护）
        ↓
/spec.specify   →  specs/NNN-slug/spec.md          需求：背景目标 + 功能需求
        ↓
/spec.clarify   →  消解 [NEEDS CLARIFICATION]       （有歧义才跑）
        ↓
/spec.design    →  <project>.pen + design.md        Pencil UI 定稿（有界面才跑）
        ↓
/spec.plan      →  plan.md + research/data-model/contracts   技术方案
        ↓
/spec.tasks     →  tasks.md                         任务规划（按用户故事切片）
        ↓
/spec.analyze   →  跨产物一致性报告                  （可选门禁）
        ↓
/spec.implement →  代码                              实现
        ↓
/spec.uicheck   →  ui-check/report.md               代码 ↔ 设计稿 drift（有界面才跑）
        ↓
/spec.verify    →  验证收尾                          lint/typecheck/test/spellcheck + 实跑截图
```

每一环的产出都是**下一环的唯一输入**。跳环会让下游失去依据，属于流程违规——
除非该环明确标注「有界面才跑」「有歧义才跑」而条件不成立。

## 产物落位

```
<project>/
├── AGENTS.md                      # 项目宪法，见下节
├── <project>.pen                  # 设计稿唯一真源（如 magicut.pen）
└── specs/
    ├── README.md                  # 编号与分支约定
    └── NNN-slug/
        ├── spec.md                # /spec.specify   需求规格（第一、二层）
        ├── design.md              # /spec.design    UI 定稿说明 + frame 索引
        ├── plan.md                # /spec.plan      技术方案（第三层）+ 宪法门禁
        ├── research.md            # /spec.plan      技术选型调研（有未知才写）
        ├── data-model.md          # /spec.plan      核心实体与字段（有数据才写）
        ├── contracts/             # /spec.plan      接口契约（有接口才写）
        ├── tasks.md               # /spec.tasks     任务清单
        └── ui-check/              # /spec.uicheck   drift 报告与对比截图
```

`NNN` 是三位零填充序号，从 `001` 递增；`slug` 是简短英文 kebab-case。
新需求的序号 = `specs/` 下已有最大序号 + 1。

## 分支约定

每个需求一条分支，分支名与目录名一致：`NNN-slug`（例：`002-auto-storyboard`）。

- `/spec.specify` 创建目录时**同时**创建并切换分支——这是流程里唯一被授权的建分支动作，
  且必须先向用户确认（AGENTS.md 禁止未经确认的 Git 操作）。
- 其余命令不做任何 Git 操作。
- 提交由用户显式发起，走 `pnpm commit`（commitlint 规范见 magicut-quality-gate）。

## 项目宪法就是 AGENTS.md

本团队**不另建** `constitution.md`。项目根的 `AGENTS.md` 已经承担了宪法职责：
语言约定、Git 约束、编码原则、验证命令、高风险操作确认、工程上下文。

`/spec.plan` 的宪法门禁直接对 AGENTS.md 逐条核对，外加以下 skill 里的硬约束：

| 领域 | 约束来源 |
| --- | --- |
| 依赖 / monorepo / 打包 | `magicut-workspace-ops` |
| 主进程 / IPC / preload | `magicut-electron-bridge` |
| 渲染层页面 / 路由 / 样式 | `magicut-renderer-ui` |
| 测试 | `magicut-testing` |
| 验证收尾 / 提交 | `magicut-quality-gate` |
| Pencil 设计闭环 | `pencil-ui-loop` |

门禁不通过时有两个出路：改方案，或在 `plan.md` 的「复杂度豁免」表里写明**为什么必须违反**、
**评估过的更简方案为什么不行**。没有第三条路，不许静默绕过。

## 规格的三个层级

| 层级 | 回答 | 落在 | 缺失的后果 |
| --- | --- | --- | --- |
| 第一层 背景与目标 | 为什么要做 | `spec.md` | AI 在模糊决策点只盯技术细节，算法炫技 |
| 第二层 功能需求 | 具体要做什么 | `spec.md` | 只产出 Happy Path，边界和异常全缺 |
| 第三层 技术方案 | 技术上怎么做 | `plan.md` | 结构、风格、质量下限失控 |

层层递进，上层缺失时下层的精确性是空中楼阁。

## 模板

模板在本 skill 的 `templates/` 下，按需读取，不要一次性全读：

| 命令 | 模板 |
| --- | --- |
| `/spec.specify` | `templates/spec-template.md` |
| `/spec.design` | `templates/design-template.md` |
| `/spec.plan` | `templates/plan-template.md` |
| `/spec.tasks` | `templates/tasks-template.md` |

## 写规格的硬规则

- **需求层不写技术**。`spec.md` 里出现框架名、库名、文件路径就是串层了，挪到 `plan.md`。
- **拿不准就标记，不要猜**。写 `[NEEDS CLARIFICATION: 具体问题]`，由 `/spec.clarify` 收口。
  猜一个默认值然后闷头实现，是这条链路上最贵的错误。
- **用户故事必须能独立交付**。P1 单独做完就应当能上线并产生价值，P2/P3 是增量。
  切不出独立切片，说明需求还没拆到位。
- **验收标准用 Given/When/Then**，且必须可机器或人工判定。「体验流畅」不是验收标准。
- **成功指标不绑技术**。写「3 分钟出片」而不是「接口 P99 < 200ms」。
- **功能需求编号 FR-001 递增**，全文档唯一，`tasks.md` 和测试用它回指。

## 与既有 agent 的分工

`/spec.*` 命令负责**流程与产物**，具体执行仍复用已有 agent：

| 环节 | 复用 |
| --- | --- |
| `/spec.implement` 的功能实现 | `magicut-feature` |
| `/spec.verify` 的验证收尾 | `magicut-verifier` |
| 实现后的合规审查 | `magicut-reviewer` |
| 环境 / 构建故障 | `magicut-doctor` |
| 新工程初始化 | `magicut-init` |

不要在 `/spec.*` 里重复这些 agent 已经写清楚的细节，直接转交。
