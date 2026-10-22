// 类型真源是 preload 暴露的对象，这里只做全局挂载。
//
// 链路四处同步：ipcMain.handle → preload invoke → 这里 → eslint globals。
interface Window {
    /**
     * 只在 Electron 里存在。
     *
     * vitest(jsdom) 与 `pnpm ui:shot` 的离屏浏览器里**都没有**，
     * 所以标成可选——渲染层一律经 `renderer/data/bridge.ts` 访问，
     * 那里把"没有桥"处理成一个明确状态。
     */
    magicutAPI?: import('./client/preload').MagicutApi;
}
