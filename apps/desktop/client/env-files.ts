import { config as loadDotenv } from 'dotenv';
import { existsSync } from 'node:fs';
import path from 'node:path';

/**
 * 找 `.env` 并载入主进程的 `process.env`。
 *
 * ## 为什么要「找」而不是写死一个路径
 *
 * `app.getAppPath()` 在开发（Forge + Vite）、打包、`electron .` 三种形态下指向不同层级，
 * 写死 `../../.env` 只在其中一种成立。**用户把文件放对了却读不到**是最难查的一类问题：
 * 应用只会说"没配凭证"，而文件明明就在那儿。
 *
 * 所以这里从 app 目录逐级往上找，再加上 userData 与进程当前目录，
 * 并且**把找过的位置记下来**——失败时要能直接告诉用户"我在这几个地方找过"。
 *
 * ## 凭证只在主进程
 *
 * 载入的变量一个字节都不往渲染层送（plan.md §4.3）。这里也**只记录路径，不记录值**。
 */

export interface EnvFileReport {
    /** 依次找过的位置 */
    searched: string[];
    /** 真正读到的文件 */
    loaded: string[];
}

/**
 * 候选位置，按优先级从高到低。
 *
 * dotenv 不覆盖已存在的变量，所以先读到的赢；命令行里 `FOO=1 pnpm start`
 * 这种临时覆盖也因此始终优先。
 */
export function envSearchPaths(
    appPath: string,
    userDataDir: string,
    cwd: string = process.cwd(),
    /** 向上找几层。monorepo 里 app 目录到仓库根通常是 2 层，给到 4 层留余量 */
    levels = 4
): string[] {
    const paths: string[] = [];
    let dir = appPath;

    for (let i = 0; i <= levels; i += 1) {
        paths.push(path.join(dir, '.env'));
        const parent = path.dirname(dir);
        if (parent === dir) break;
        dir = parent;
    }

    paths.push(path.join(userDataDir, '.env'));
    paths.push(path.join(cwd, '.env'));

    // 上面几路很容易撞车（cwd 往往就是仓库根），去重后顺序不变
    return [...new Set(paths)];
}

export function loadEnvFiles(paths: readonly string[]): EnvFileReport {
    const loaded: string[] = [];

    for (const file of paths) {
        if (!existsSync(file)) continue;
        loadDotenv({ path: file, quiet: true });
        loaded.push(file);
    }

    return { searched: [...paths], loaded };
}
