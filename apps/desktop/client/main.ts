import { app, BrowserWindow } from 'electron';
import started from 'electron-squirrel-startup';
import path from 'node:path';

import type { AgentRunner } from './agent-runner';
import { envSearchPaths, loadEnvFiles } from './env-files';
import { registerIpc, resolveAppPaths } from './ipc';
import {
    registerMediaProtocol,
    registerMediaSchemePrivileges
} from './media-protocol';
import { readProject } from './project-store';

if (started) {
    app.quit();
}

// 凭证从 .env 进 process.env，**只在主进程**。
// 渲染层拿得到的东西等同于公开（plan.md §4.3），一个字节都不往那边送。
//
// 从 app 目录逐级往上找，外加 userData 与进程当前目录——理由见 env-files.ts。
const envPaths = envSearchPaths(app.getAppPath(), app.getPath('userData'));
const envReport = loadEnvFiles(envPaths);

// 启动时把结果打出来：**只打路径与"有没有 key"，绝不打值**。
// 没有这一行的话，"文件明明放了却说没配凭证"只能靠猜
// eslint-disable-next-line no-console
console.log(
    `[env] 读到 ${envReport.loaded.length} 个 .env` +
        (envReport.loaded.length > 0
            ? `：${envReport.loaded.join(', ')}`
            : '') +
        ` | LLM_PROVIDER=${process.env['LLM_PROVIDER'] ?? '(未设置)'}` +
        ` | ARK_API_KEY ${process.env['ARK_API_KEY'] ? '已设置' : '未设置'}`
);

// 必须在 app ready 之前声明，否则 `<video>` 拿不到 range 支持
registerMediaSchemePrivileges();

let mainWindow: BrowserWindow | null = null;
let runner: AgentRunner | null = null;

const createWindow = () => {
    mainWindow = new BrowserWindow({
        width: 1440,
        height: 900,
        backgroundColor: '#09090b',
        webPreferences: {
            preload: path.join(__dirname, 'preload.js')
        }
    });

    mainWindow.on('closed', () => {
        mainWindow = null;
    });

    if (MAIN_WINDOW_VITE_DEV_SERVER_URL) {
        mainWindow.loadURL(MAIN_WINDOW_VITE_DEV_SERVER_URL);
        return;
    }

    mainWindow.loadFile(
        path.join(__dirname, `../renderer/${MAIN_WINDOW_VITE_NAME}/index.html`)
    );
};

app.whenReady().then(() => {
    const paths = resolveAppPaths();
    runner = registerIpc(() => mainWindow, {
        ...paths,
        envSearchPaths: envReport.searched
    });

    /**
     * 预览要读工程里的素材。
     *
     * **渲染层给的是 id，不是路径**（`miaoma-media://project/<目录>/<kind>/<id>`）。
     * 主进程按工程 JSON 把 id 翻译成路径——能读到什么由工程文件决定，
     * 不由 URL 决定。越权从"要不要拦"变成了"根本表达不出来"。
     */
    registerMediaProtocol({
        loadProject: (projectId) => readProject(paths.projectsRoot, projectId)
    });

    createWindow();

    app.on('activate', () => {
        if (BrowserWindow.getAllWindows().length === 0) {
            createWindow();
        }
    });
});

// 退出前释放数据库句柄。不释放的话 wasm 那边的文件锁会留到进程被杀
app.on('will-quit', () => {
    runner?.disposeAll();
});

app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') {
        app.quit();
    }
});
