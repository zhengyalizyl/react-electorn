---
description: 代码与 Pencil 设计稿的一致性校验，产出 drift 报告
argument-hint: [需求编号，如 002；留空则取最新的]
---

Pencil 闭环的第三段。实跑截图 vs 设计稿截图，逐项核对。

先读 `pencil-ui-loop` skill 的 C 段。

目标需求：$ARGUMENTS（留空则取 `specs/` 下序号最大的）

## 前置检查

- `design.md` 存在且含 frame id
- pencil MCP 可用（要拿设计稿截图）。不可用就告诉用户并停下

## 步骤

1. **拿设计稿截图**：`TakeScreenshot([frameId])`，对 `design.md` 里每个 frame 都截。

2. **拿实跑截图**：

   ```bash
   pnpm ui:shot --route=<路由> --out=.ui-out/<name>.png
   ```

   窗口尺寸用设计稿 frame 的尺寸（编辑器是 `--width=1920 --height=1094`，这也是默认值）。

3. **整屏先比**，再对差异明显的区块用 `--selector` 逐块比：

   ```bash
   pnpm ui:shot --route=<路由> --out=.ui-out/<block>.png \
     --selector='<CSS 选择器>' --no-build
   ```

4. **逐项核对**（清单见 `pencil-ui-loop` C 段）：区块顺序、文案逐字、颜色、字号字重行高、
   间距内边距、圆角描边、图标、选中态表现。

5. **处置每一条差异**：
   - 代码错了 → 改代码
   - 设计稿错了 → 回 `/spec.design` 改 `.pen`，**不要在代码里将就**
   - 有意偏离（例如设计稿定高在应用里改成了 `flex-1`）→ 记录理由，标为「已接受」

## 产出

写 `specs/NNN-slug/ui-check/report.md`：

```markdown
# UI 一致性报告：[需求名]

| | |
| --- | --- |
| 日期 | YYYY-MM-DD |
| 设计稿 frame | `xxxxx` |
| 实跑截图 | `.ui-out/xxx.png` |

## 差异清单

| 项 | 设计稿 | 实际 | 处置 |
| --- | --- | --- | --- |
| 分镜卡片内边距 | 上12 右12 下14 左12 | 全 12 | 已改代码 |
| Body 高度 | 692 固定 | flex-1 | 已接受：窗口可缩放，固定高会溢出 |

## 结论

无未处置 drift / 尚有 N 项待处置
```

截图不进仓库（`.ui-out/` 已 gitignore），报告进仓库。

## 结束时

汇报：核对了几个 frame、发现几项差异、各自怎么处置的、是否还有未决项。
全部处置后提示跑 `/spec.verify`。
