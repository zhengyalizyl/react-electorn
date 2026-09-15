---
name: pencil-ui-loop
description: Pencil（pen.dev）设计稿与代码的三段闭环——需求生成设计稿、设计稿转 React 代码、代码与设计稿一致性校验。在执行 /spec.design 或 /spec.uicheck 时使用；在用户说"按设计图实现 / 把 xx frame 做出来 / 设计稿改了同步一下 / UI 对不对得上"时也使用。触发词：pencil、pen.dev、.pen、设计稿、设计图、frame、design token、UI 还原、drift。
---

# Pencil UI 闭环

`.pen` 是加密文件，**只能**通过 pencil MCP 工具读写，绝不用 Read/Grep 打开。

## 三段闭环

| 段 | 触发 | 输入 → 输出 |
| --- | --- | --- |
| A 需求 → 设计稿 | `/spec.design` | `spec.md` → `.pen` 里的新 frame + 截图评审 |
| B 设计稿 → 代码 | `/spec.implement` 的 UI 任务 | frame → React 组件 + 设计令牌 |
| C 代码 ↔ 设计稿 | `/spec.uicheck` | 实跑截图 vs frame 截图 → drift 报告 |

A 段可跳过（UI 已由设计师定稿），B、C 不可跳过。

---

## A 段：需求 → 设计稿

动手前必读 pencil 的自带文档，不要凭记忆写 `execute` 代码：

```
mcp__pencil__read_skill()                      # 总览 + .pen schema 入口
mcp__pencil__read_skill({ path: 'execute.md' }) # execute API，必读
```

要点（完整规则以 pencil 自带文档为准）：

- 先 `get_app_state` 确认当前 `.pen` 文件与已有顶层 frame，避免覆盖既有设计。
- 新屏幕用 `FindEmptySpace` 找位置，作为 `document` 的顶层 frame，设 `clip: true`。
- 整个绘制过程给 frame 挂 `placeholder: true`，完成后立刻取消。
- 设计令牌用 `SetVariables` 先定义，节点用 `$token` 引用；不要散落硬编码色值。
- 重复 UI 先做成 `reusable: true` 组件再实例化，改一处全量生效。
- 每完成一个区块就 `TakeScreenshot` 自查，不要攒到最后。

产出写进 `specs/NNN-slug/design.md`（模板见 `spec-workflow/templates/design-template.md`），
必须包含 frame id——B 段靠它定位。

---

## B 段：设计稿 → 代码

### 读取顺序

按这个顺序读，既拿得全又不炸上下文：

1. `get_app_state` → 拿到当前 `.pen` 与顶层 frame id
2. `Get(frameId, (n, c) => Print(...), { depth: 4 })` → 一行一节点的结构总览，
   同时用 `c.bounds` 拿到解析后的尺寸、用 `c.problems` 发现溢出
3. 按区块 `Print(JSON.stringify(Get(sectionId, { depth: 9 })))` → 拿完整属性
4. `TakeScreenshot([frameId])` → 校验自己的理解与视觉一致
5. 有 SVG 路径时才加 `includePathGeometry: true`，几何数据必须原样抄，不许近似

默认**不要**加 `resolveVariables: true`——保留 `$token` 引用，才知道哪些值该落成 CSS 变量。

### pen → Tailwind v4 映射

| .pen | Tailwind |
| --- | --- |
| `layout: "vertical"` | `flex flex-col` |
| `layout` 缺省（水平） | `flex` |
| `layout: "none"` + 子节点 x/y | 父 `relative`，子 `absolute left-[Xpx] top-[Ypx]` |
| `layoutPosition: "absolute"` | `absolute` |
| `width/height: "fill_container"` | 主轴 `flex-1`，交叉轴 `w-full` / `h-full` |
| `width/height: "fit_content"` | 不写尺寸类 |
| `gap: 12` | `gap-3`（除 4；非整除用 `gap-[13px]`） |
| `padding: 16` | `p-4` |
| `padding: [12, 12, 14, 12]` | `pt-3 pr-3 pb-3.5 pl-3` |
| `justifyContent: "space_between" / "center" / "end"` | `justify-between` / `justify-center` / `justify-end` |
| `alignItems: "center" / "end"` | `items-center` / `items-end` |
| `cornerRadius: 8` | `rounded-lg`（非标准值用 `rounded-[Npx]`） |
| `cornerRadius: "$r-full"` | `rounded-full` |
| `clip: true` | `overflow-hidden` |
| frame 的 `fill` | `bg-*` |
| text 的 `fill` | `text-*` |
| `stroke` + `strokeWidth: 1` | `border border-*` |
| `stroke` + `strokeWidth: { bottom: 1 }` | `border-b border-*` |
| `fill` 为 gradient，`rotation: 135` | `bg-linear-135 from-* to-*` |
| 带 alpha 的色值 `#FFFFFF1F` | `bg-white/12` |
| `lineHeight: 1.55` | `leading-[1.55]` |
| `letterSpacing: 0.5` | `tracking-[0.5px]` |
| `fontSize: 13` | `text-[13px]` |
| `fontWeight: "bold"` | `font-bold` |
| 文本 `content` 里含 `\n` | `whitespace-pre-line`，字符串原样保留换行 |
| `type: "ellipse"` | `rounded-full` 的 span |
| `type: "icon"`, `library: "lucide"` | `lucide-react` 同名组件（`scissors` → `Scissors`） |

### 设计令牌落地

`.pen` 的 `SetVariables` 变量 → Tailwind v4 的 `@theme`，命名保持一致：

```css
/* renderer/index.css */
@theme {
    --color-ed-bg: #09090b;      /* $ed-bg  → bg-ed-bg / text-ed-bg / border-ed-bg */
    --font-ed-mono: 'JetBrains Mono', ui-monospace, monospace;  /* $ed-mono → font-ed-mono */
}
```

只出现一次的色值（某个片段的背景）不要进 `@theme`，用 arbitrary value 或内联 `style`。
由数据驱动的颜色（轨道片段的 5 种配色）走 `style={{ backgroundColor: clip.bg }}`，
不要拼 `bg-[${...}]`——Tailwind 扫描不到动态拼接的类名。

### 尺寸：设计稿是固定的，应用不是

设计稿的 frame 是定宽定高的画布，代码不能照抄所有固定尺寸：

- 侧栏这类**定宽**面板照抄（`w-[310px] shrink-0`）。
- 主区、内容区改成 `flex-1 min-w-0` / `min-h-0`，否则窗口一缩就溢出。
- 设计稿里 `height: 692` 的 Body 在代码里应当是 `flex-1`，只有工具栏、轨道行这类
  真正定高的才写 `h-11`。
- 可滚动区加 `overflow-y-auto`，并配暗色滚动条（见下）。

### 设计稿没有、但代码必须有的东西

设计稿只表达视觉，以下是实现时必须补的：

- **纯图标按钮补 `aria-label`**（工具栏的分割/关联/音频、发送按钮）。
- **面板补 landmark 名称**（`<aside aria-label="文稿字幕">`），组件测试要靠它按语义查询。
- **语义标签**：标题用 `h1/h2/h3`，列表用 `ul/li`，可点区域用 `<button type="button">`。
- **暗色滚动条**：macOS 默认 overlay 滚动条是浅色的，压在暗色面板上很突兀。
  用 `scrollbar-color` + `::-webkit-scrollbar*` 定义一个 `@utility`，并给根节点加 `scheme-dark`。

### 引入 lucide-react 的连带改动

设计稿的 icon 节点用 lucide 图标库。装 `lucide-react` 后**必须**同步改
`apps/desktop/vite.renderer.config.ts`，把它加进 `resolve.dedupe` 和 `optimizeDeps.include`——
hoisted 布局下漏加会出现两份 React 导致白屏，原因见 `magicut-renderer-ui`。

---

## C 段：代码 ↔ 设计稿一致性

```bash
# 实跑截图：整页
pnpm ui:shot --route=/editor --out=.ui-out/editor.png

# 实跑截图：只截某个区域，用于逐块比对
pnpm ui:shot --route=/editor --out=.ui-out/rail.png \
  --selector='nav[aria-label="素材类型"]' --no-build
```

对照 `TakeScreenshot([frameId])` 的设计稿截图，逐项核对：

- [ ] 区块数量、顺序、相对位置一致
- [ ] 文案逐字一致（含标点、空格、`·` 这类分隔符）
- [ ] 颜色：背景、文字、描边、强调色
- [ ] 字号、字重、行高
- [ ] 间距与内边距
- [ ] 圆角、描边宽度与方向
- [ ] 图标形状与尺寸
- [ ] 选中态 / 当前态的表现（哪一项高亮、怎么高亮）

有差异时**改代码**对齐设计稿；确属设计稿的问题，回到 A 段改 `.pen`，不要在代码里将就。
结论写进 `specs/NNN-slug/ui-check/report.md`，差异项列明「设计稿值 / 实际值 / 处置」。

`--no-build` 在反复截图时复用上次构建，能省掉每次 1~2 秒的构建。改了代码要去掉它。

---

## 踩过的坑

- **设计稿里的占位乱码文案**（`asdfasdfasdf` 这类）会被 cspell 拦。按设计稿原样保留文案，
  把词加进 `.cspell/custom-words.txt`，并在交付说明里提醒用户替换成正式文案。
- **离屏截图看不到 macOS overlay 滚动条**。要验证滚动条样式，用 `--selector` 截容器右缘，
  或先用 `executeJavaScript` 设 `scrollTop` 再截。
- **`Generate` 是异步的**，`execute` 返回后图还没落盘。靠 `Print(Get(id, {depth:0}).placeholder)`
  轮询，间隔放长，不要连续打；更不要重复 Generate 或自己用 path 画。
- **图标、箭头、勾选这类 UI 图形不要 Generate SVG**，用 `icon` 节点。SVG 生成只留给
  logo、吉祥物、插画这类真正的自由矢量图形。
