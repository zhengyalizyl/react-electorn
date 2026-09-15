---
description: 按 tasks.md 执行实现，UI 任务走 Pencil 设计稿转代码
argument-hint: [需求编号，或 "NNN P1" 只做某一组；留空则取最新需求的下一组]
---

按任务清单实现。**依据是 `tasks.md` 和 `design.md`，不是你对需求的印象**。

目标：$ARGUMENTS（留空则取最新需求里第一组未完成的任务）

## 前置检查

- `tasks.md` 存在
- 跑过 `/spec.analyze` 且无阻断项。没跑过就提示用户，但不强制

## 执行规则

1. **一次只做一组**（一个用户故事的任务组）。做完就停下来验证并汇报，
   不要一口气把 P1/P2/P3 全做完——那样出问题定位不到是哪一组引入的。

2. **按编号顺序**执行；`[P]` 的相邻任务可一起改。

3. **UI 任务走 Pencil B 段**：读 `pencil-ui-loop` skill 的 B 段，
   按 `design.md` 的 frame id 从 `.pen` 读设计，按映射表转成 Tailwind。
   不要照着 `design.md` 的文字描述写样式——文字描述不是真源，frame 才是。

4. **具体实现转交 `magicut-feature`** 这个 agent 更高效时就转交，
   它已经写清了主进程 / preload / 类型 / eslint globals / 路由 / 测试这条完整链路。
   不要在这里重复它的内容。

5. **连带改动不许漏**。`tasks.md` 里显式列了的照做；执行中发现清单漏了的，
   补做并在汇报里指出「任务清单缺了这条」——这是给下次拆任务的反馈。

6. **每完成一个任务就勾掉** `tasks.md` 里对应的行，保持清单是当前真实状态。

## 组内完成后

跑该组的交付验证（`tasks.md` 里那几条 checkbox）：

```bash
pnpm --filter @magicut-react/desktop exec tsc --noEmit
pnpm lint
pnpm test:run
```

失败就修到过，不要带着红灯往下一组走，也不要放宽断言或加 skip 让它变绿。

## 结束时

汇报：完成了哪一组、改了哪些文件、验证结果、任务清单是否有遗漏项被补做。

提示下一步：
- 还有未完成的组 → 再跑一次 `/spec.implement`
- 全部完成且有界面 → `/spec.uicheck`
- 全部完成且无界面 → `/spec.verify`

不执行任何 Git 操作。
