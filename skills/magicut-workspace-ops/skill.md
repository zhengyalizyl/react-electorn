---
name: magicut-workspace-ops
description: 在 magicut-react 仓库安装依赖、增删依赖、跑某个子包命令、打包分发或排查 Electron 安装失败时使用。覆盖 pnpm workspace 硬约束（hoisted、allowBuilds、镜像）、--filter 用法、package/make 命令与 fix:electron 排障。触发词：pnpm install 失败、装依赖、Electron 下载失败、打包、make、monorepo、workspace、子包命令。
---

# magicut-react 工程与依赖操作

> 路径基准：本文档中的相对路径与命令均以仓库内的 `magicut-react/` 目录为准，
> 例如 `apps/desktop/client/main.ts` 实为 `magicut-react/apps/desktop/client/main.ts`，
> 所有 `pnpm` 命令都需在 `magicut-react/` 下执行。


## 三条不可删的硬约束

| 位置 | 配置 | 为什么不能删 |
| --- | --- | --- |
| `.npmrc` | `node-linker=hoisted` | Electron Forge 的硬性要求，pnpm 默认的符号链接布局会让 Forge 打包失败 |
| `pnpm-workspace.yaml` | `nodeLinker: hoisted` + `allowBuilds` | 同上；`allowBuilds` 放行 electron / electron-winstaller / esbuild / sharp 的安装脚本 |
| 根 `package.json` | `pnpm.onlyBuiltDependencies` | 与 `allowBuilds` 配套，二者要同步维护 |

`.npmrc` 里还有 `electron_mirror=https://npmmirror.com/mirrors/electron/`，用于国内网络下载 Electron 二进制。

新增会跑 postinstall 的原生依赖（如 `sharp`、`better-sqlite3`）时，必须**同时**加进 `pnpm-workspace.yaml` 的 `allowBuilds` 和根 `package.json` 的 `pnpm.onlyBuiltDependencies`，否则安装后二进制缺失、运行时才报错。

## workspace 布局

```yaml
packages:
  - "apps/*"     # desktop（Electron）、server（Next.js）
  - "demos/*"
  - "packages/*" # 内部包，目前为空
```

包名：`@magicut-react/desktop`、`@magicut-react/server`。

## 给子包装依赖

```bash
pnpm --filter @magicut-react/desktop add <pkg>
pnpm --filter @magicut-react/desktop add -D <pkg>
pnpm add -w -D <pkg>          # 只有工具链（eslint/prettier/cspell 等）才装到根
```

不要在子包目录里直接 `npm install` / `yarn`。

## 常用命令

根 `package.json` 的脚本基本都是 `pnpm --filter ... ` 的转发：

| 命令 | 实际动作 |
| --- | --- |
| `pnpm start` / `pnpm dev:desktop` | `electron-forge start` |
| `pnpm dev:server` | `next dev` |
| `pnpm package:mac` / `pnpm package:win` | `electron-forge package --platform darwin` / `win32 --arch x64` |
| `pnpm make:mac` / `pnpm make:win` | 生成安装包（Squirrel / ZIP / RPM / DEB） |
| `pnpm fix:electron` | 手动重装 Electron 二进制 |

跨包批量脚本用 `pnpm -r --if-present run <script>`（`lint` / `format` / `typecheck` / `test:run` 都是这个模式），所以**子包新增脚本时用同名脚本名**才能被根命令带上。

## Electron 安装失败排障

症状：`pnpm start` 报找不到 Electron 可执行文件、`electron/dist` 为空、或安装时二进制下载超时。

```bash
pnpm fix:electron
```

`scripts/fix-electron-install.mjs` 做的事：读 `apps/desktop/node_modules/electron/package.json` 里的版本 → 用 `@electron/get` 从镜像强制重下 → 解压到 `electron/dist` → 写 `path.txt` → 校验可执行文件存在 → 非 Windows 下 `chmod 755`。

镜像可用环境变量覆盖：`ELECTRON_MIRROR` 或 `npm_config_electron_mirror`。目标平台/架构用 `npm_config_platform` / `npm_config_arch`。

依赖 `unzip` 命令存在。如果仍失败，先确认 `apps/desktop/node_modules/electron` 目录本身存在（不存在说明是 `pnpm install` 阶段就断了，先重跑安装）。

## 环境要求

Node.js >= 20，pnpm >= 9。

## 打包注意

- `forge.config.ts` 的 `packagerConfig.name` 是中文 `妙码智能剪辑平台`，产物路径含中文，脚本里处理路径时**用双引号包裹并用 `/` 作分隔符**。
- Windows 包固定 `--arch x64`。
- 新增 renderer target 时要同步改 `forge.config.ts` 的 `VitePlugin.renderer` 数组和主进程的 `MAIN_WINDOW_VITE_NAME` 分支逻辑。

## 高风险操作

全局安装/卸载/升级包、删除 `node_modules` 之外的目录、改 `.npmrc` / `pnpm-workspace.yaml` 的上述硬约束，都属于 AGENTS.md 定义的高风险操作，**执行前必须先向用户确认**。
