---
name: figma-to-react

description: 根据 Figma 设计稿链接生成符合团队规范的 React 组件，包含类型定义、Tailwind 样式和单元测试。用于UI还原和组件库开发。
---

# Figma 转 React 组件流程

## 步骤

1. 使用 Figma MCP 工具读取设计稿节点信息

   - 获取 Frame 尺寸、颜色、字体、间距

   - 识别组件结构和层级关系

2. 分析设计稿，拆分为子组件

3. 生成 TypeScript 接口定义

4. 使用 Tailwind CSS 实现样式

5. 生成 Jest 单元测试

6. 运行验证命令

## 约束

- 严格遵循 AGENTS.md 技术规范

- 颜色使用 Tailwind 自定义颜色变量，不硬编码 hex

- 字体大小使用 Tailwind 字体体系

- 间距使用 Tailwind 间距体系（4px 基准）

## 验证

完成后运行：

npm run lint && npm run type-check && npm test
