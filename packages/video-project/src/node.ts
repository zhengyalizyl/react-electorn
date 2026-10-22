/**
 * **仅 Node 环境**的导出面。
 *
 * `io.ts` 依赖 `node:fs/promises` / `node:crypto`，浏览器里既跑不了也不该跑。
 * 把它从主 barrel 拆出来，是为了让边界由**模块系统强制**，而不是靠约定——
 * 渲染层 `import '@magicut-react-demo/video-project'` 时根本看不到这些符号，
 * 想误用都没机会。
 *
 * 这个问题是 B2 接入渲染层时才暴露的：单测跑在 jsdom 上，node 内建模块照样能解析，
 * 只有真正的浏览器产物构建才会报 `"randomUUID" is not exported by "__vite-browser-external"`。
 */
export * from './io';
