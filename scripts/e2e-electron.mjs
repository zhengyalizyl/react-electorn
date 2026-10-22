// 真机端到端：把桌面端**真的跑起来**，驱动它，再断言看到的东西。
//
// 用法：
//   pnpm e2e                      跑全部（不花钱）
//   pnpm e2e --live               **额外**跑要调云端模型的那一条，会产生费用
//   pnpm e2e --keep               跑完不关窗口，留着自己看
//   pnpm e2e --out=.ui-out/e2e    截图输出目录（默认 .ui-out/e2e）
//
// ## 花不花钱，是这里最要紧的一条分界
//
// **本地 IndexTTS2 是免费的**：它跑在你自己机器上，配了 `INDEX_TTS_URL`
// 就自动验"用你传的音色真合成一段出来"。没配就跳过并说清楚缺什么。
//
// **云端模型要钱**：改写分镜文案要调方舟。所以默认把凭证清掉，让那条路
// 根本发不出去；要验它得显式加 `--live`。
//
// 这条界划在这儿，是因为"跑个自检"不该变成一件需要先想想花多少钱的事。
//
// ## 这个脚本验的是单测**验不了**的那一层
//
// `apps/desktop/tests/*` 里的桥是假的（`fake-bridge.ts`）——它保证界面逻辑对，
// 但**假桥和真 preload 对不对得上，它一个字都保证不了**。契约漂了的话，
// 测试全绿而真机上一点就炸。这里用的是真 preload、真主进程、真 IPC。
//
// ## 不碰你的真数据
//
// `--user-data-dir` 指向临时目录：上传的样本进的是那儿，不会混进你真的音色库。
// 工程根也用 `MAGICUT_PROJECTS_DIR` 指走。
//
// ## 外部服务不是前提
//
// 本地 IndexTTS2 与方舟凭证都**不要求**。脚本只断言"界面把真实状态如实说出来"——
// 没配就该显示没配。要验真出声，配好之后再跑，那几条断言会自动变严。

import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { _electron } from 'playwright';

const rootDir = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    '..'
);
const desktopDir = path.join(rootDir, 'apps/desktop');
const mainEntry = path.join(desktopDir, '.vite/build/main.js');

const args = new Map(
    process.argv.slice(2).map((arg) => {
        const [key, ...rest] = arg.replace(/^--/, '').split('=');
        return [key, rest.length > 0 ? rest.join('=') : 'true'];
    })
);
const outDir = path.resolve(rootDir, args.get('out') ?? '.ui-out/e2e');
const keepOpen = args.get('keep') === 'true';
/** 允许真调一次云端模型。**默认关**，理由见文件头 */
const live = args.get('live') === 'true';

/** 断言结果。**全部跑完再汇总**，不是第一条红就退出——一次就看清全貌 */
const results = [];
function check(name, ok, detail = '') {
    results.push({ name, ok, detail });
    console.log(
        `${ok ? '  ✔' : '  ✘'} ${name}${detail ? ` — ${detail}` : ''}`
    );
}

/**
 * 跳过一条，**并说清楚缺什么**。
 *
 * 不计进成败：缺的是外部服务，不是代码有问题。但必须印出来——
 * 一行不说地少跑三条，下次看输出的人会以为那几条本来就不存在。
 */
function skip(name, why) {
    results.push({ name, ok: true, skipped: true });
    console.log(`  ○ ${name} — 跳过：${why}`);
}

/**
 * 一个**真正合法**的 16bit PCM 静音 WAV。
 *
 * 不能写个空文件了事：主进程收样本时要用 ffprobe 量时长、确认它真是音频
 * （`voice-samples.ts` 的 `probeAudio`），空文件会被当场拒掉——
 * 那样测到的是"拒绝路径对不对"，不是"收进来之后界面变没变"。
 */
function silentWav(seconds = 12) {
    const rate = 24_000;
    const frames = rate * seconds;
    const dataSize = frames * 2;
    const header = Buffer.alloc(44);
    header.write('RIFF', 0, 'ascii');
    header.writeUInt32LE(36 + dataSize, 4);
    header.write('WAVE', 8, 'ascii');
    header.write('fmt ', 12, 'ascii');
    header.writeUInt32LE(16, 16);
    header.writeUInt16LE(1, 20);
    header.writeUInt16LE(1, 22);
    header.writeUInt32LE(rate, 24);
    header.writeUInt32LE(rate * 2, 28);
    header.writeUInt16LE(2, 32);
    header.writeUInt16LE(16, 34);
    header.write('data', 36, 'ascii');
    header.writeUInt32LE(dataSize, 40);
    return Buffer.concat([header, Buffer.alloc(dataSize)]);
}

/**
 * 起渲染层的 dev server，拿到它的地址。
 *
 * 走 dev server 而不是生产构建：主进程认 `MAIN_WINDOW_VITE_DEV_SERVER_URL`，
 * 有它就 `loadURL`，没有才去读打包产物——而那份产物要走完整的 forge package，
 * 为一次端到端等上几分钟不值当。
 */
function startRenderer() {
    return new Promise((resolve, reject) => {
        const child = spawn(
            'npx',
            ['vite', '--config', 'vite.renderer.config.ts', '--port', '5199'],
            { cwd: desktopDir, stdio: ['ignore', 'pipe', 'pipe'] }
        );

        const timer = setTimeout(
            () => reject(new Error('渲染层 dev server 30 秒没起来')),
            30_000
        );

        child.stdout.on('data', (chunk) => {
            const text = String(chunk);
            const hit = text.match(/Local:\s+(http:\/\/\S+)/);
            if (hit) {
                clearTimeout(timer);
                resolve({ child, url: hit[1].replace(/\/$/, '') });
            }
        });
        child.stderr.on('data', (chunk) => process.stderr.write(chunk));
        child.on('exit', (code) => {
            clearTimeout(timer);
            reject(new Error(`渲染层 dev server 退出，code=${code}`));
        });
    });
}

async function main() {
    if (!(await exists(mainEntry))) {
        throw new Error(
            `找不到主进程产物 ${mainEntry}\n` +
                `先跑一次 \`pnpm start\`（或 \`pnpm package\`）把它构建出来`
        );
    }

    await assertFreshBundle();

    await mkdir(outDir, { recursive: true });

    // 样本与用户数据都放临时目录——**不碰你真的音色库**
    const sandbox = await mkdtemp(path.join(tmpdir(), 'magicut-e2e-'));
    const samplePath = path.join(sandbox, '我的声音.wav');
    await writeFile(samplePath, silentWav());

    console.log('› 起渲染层 dev server…');
    const renderer = await startRenderer();
    console.log(`  ${renderer.url}`);

    console.log('› 启动 Electron…');
    const app = await _electron.launch({
        args: [
            mainEntry,
            // 用户数据隔离：上传的样本进沙箱，不混进真库
            `--user-data-dir=${path.join(sandbox, 'userData')}`
        ],
        cwd: desktopDir,
        env: {
            ...process.env,
            MAIN_WINDOW_VITE_DEV_SERVER_URL: renderer.url,
            MAGICUT_PROJECTS_DIR: path.join(sandbox, 'projects'),
            /**
             * **默认把模型凭证清掉——这一条不是洁癖，是不花你的钱。**
             *
             * 下面要真的点「创建」才进得了创作页（那是个守卫路由，
             * 直接改 hash 会被弹回工作台）。留着凭证的话，每跑一次端到端
             * 就真发起一轮创作：调好几次模型、合成一整条口播。
             *
             * 清掉之后它会在开跑前就停在「没有配置模型凭证」——
             * 而默认要验的就是输入框在各档状态下说的话对不对，
             * 不是那一轮跑没跑成。
             *
             * `--live` 时原样保留：那时候用户是明确要验真调用的。
             *
             * ⚠️ `INDEX_TTS_URL` **两种模式下都不动**——本地引擎跑在
             * 自己机器上，不花钱，没理由拦。
             */
            ...(live
                ? {}
                : { ARK_API_KEY: '', TTS_API_KEY: '', LLM_PROVIDER: 'mock' })
        }
    });

    try {
        const page = await app.firstWindow();

        await settle(page, renderer.url);

        await checkBridge(page);
        const engine = await checkEngineStatus(page);
        await checkVoiceLibrary(app, page, renderer.url, samplePath, outDir);
        // 本地引擎免费，就绪就验真出声；没就绪就说清楚缺什么
        await checkVoiceSynthesis(page, engine);
        // 要钱的那条，只在 --live 时跑
        await checkLiveRevise(page);
        await checkComposer(page, renderer.url, outDir);

        if (keepOpen) {
            console.log('\n› --keep：窗口留着，Ctrl+C 退出');
            await new Promise(() => undefined);
        }
    } finally {
        if (!keepOpen) {
            await app.close().catch(() => undefined);
            renderer.child.kill();
        }
    }

    /**
     * **跳过的要单独报出来。**
     *
     * 并进"通过"里的话，一行「全过」会把"那几条根本没跑"盖掉——
     * 而没跑过的东西和验过的东西，是不能放在一起说的。
     */
    const failed = results.filter((item) => !item.ok);
    const skipped = results.filter((item) => item.skipped);
    const ran = results.length - skipped.length;

    console.log(
        `\n${failed.length === 0 ? '✔' : '✘'} ${ran - failed.length}/${ran} 条通过` +
            (skipped.length > 0 ? `，${skipped.length} 条跳过（见上）` : '')
    );
    if (failed.length > 0) process.exitCode = 1;
}

/**
 * 等窗口真的停在渲染层上。
 *
 * ## 为什么要重试，而不是 `waitForLoadState` 一次了事
 *
 * **主进程自己也在导航。** `createWindow` 里那句 `loadURL` 和我们这边的
 * `goto` 会撞车——撞上了 Playwright 报的是
 * 「Execution context was destroyed」，一句和真实原因毫无关系的话。
 *
 * 而且首帧可能是 `chrome-error://chromewebdata/`（Electron 比 dev server
 * 先就绪时）。那种时候 preload 照样注入，所以光看「桥在不在」会误以为没事，
 * 真去点界面才发现是张错误页。
 *
 * 判据定成「`window.magicutAPI` 在、而且 React 已经挂出了东西」：
 * 两个都成立才说明这一帧是真的渲染层。
 */
async function settle(page, baseUrl) {
    let last = '';
    for (let attempt = 0; attempt < 20; attempt += 1) {
        try {
            await page.goto(`${baseUrl}/#/`, {
                waitUntil: 'domcontentloaded',
                timeout: 5_000
            });
            await page.waitForFunction(
                () =>
                    Boolean(window.magicutAPI) &&
                    document.querySelector('#root')?.childElementCount > 0,
                null,
                { timeout: 5_000 }
            );
            return;
        } catch (error) {
            last = error.message;
            await new Promise((resolve) => setTimeout(resolve, 500));
        }
    }
    throw new Error(`窗口没能稳定加载渲染层：${last}`);
}

/**
 * 主进程产物**不能比源码旧**。
 *
 * ## 这一条是血的教训
 *
 * 这个脚本驱动的是 `.vite/build/main.js`，不是 `client/*.ts`。
 * 渲染层走 dev server 所以永远是新的，**主进程却是一份构建产物**——
 * 改完主进程代码直接跑 e2e，验的是改之前那一份。
 *
 * 第一次踩到的时候：修了 `llm/config.ts` 里空串凭证那个 bug，
 * 重跑 e2e 还是报同一句错，看上去像"修了没用"。实际是产物没重建。
 *
 * **"验了一份不是你刚写的代码"比没验更糟**：它给你一个假的确认。
 * 所以这里宁可拦住，让人去重建。
 */
async function assertFreshBundle() {
    const { stat, readdir } = await import('node:fs/promises');
    const built = (await stat(mainEntry)).mtimeMs;

    // 主进程打包时会把这几处的源码都拖进去
    const roots = [
        path.join(desktopDir, 'client'),
        path.join(rootDir, 'packages')
    ];

    let newest = 0;
    let newestFile = '';
    const walk = async (dir) => {
        for (const entry of await readdir(dir, { withFileTypes: true })) {
            if (entry.name === 'node_modules' || entry.name.startsWith('.')) {
                continue;
            }
            const full = path.join(dir, entry.name);
            if (entry.isDirectory()) {
                await walk(full);
            } else if (/\.(ts|tsx|mjs|cjs|js)$/.test(entry.name)) {
                const at = (await stat(full)).mtimeMs;
                if (at > newest) {
                    newest = at;
                    newestFile = path.relative(rootDir, full);
                }
            }
        }
    };
    for (const dir of roots) {
        await walk(dir).catch(() => undefined);
    }

    if (newest > built) {
        throw new Error(
            `主进程产物比源码旧，这一跑会验到改之前那一份。\n` +
                `  最新改动：${newestFile}\n` +
                `  产物时间：${new Date(built).toLocaleString('zh-CN')}\n` +
                `先跑一次 \`pnpm start\`（让 forge 重建 main/preload），再跑 e2e`
        );
    }
}

async function exists(file) {
    try {
        const { stat } = await import('node:fs/promises');
        await stat(file);
        return true;
    } catch {
        return false;
    }
}

/**
 * 真桥的形状。
 *
 * **这是单测结构上验不了的那一条**：`fake-bridge.ts` 是手写的，
 * 它和真 preload 漂了的话测试照样全绿。这里问的是真 `window.magicutAPI`。
 */
async function checkBridge(page) {
    console.log('\n› 真桥契约');
    const api = await page.evaluate(() => {
        const bridge = window.magicutAPI;
        if (!bridge) return null;
        return {
            voices: Object.keys(bridge.voices ?? {}),
            samples: Object.keys(bridge.voices?.samples ?? {}),
            projects: Object.keys(bridge.projects ?? {}),
            agent: Object.keys(bridge.videoAgent ?? {})
        };
    });

    check('window.magicutAPI 存在', api !== null);
    if (api === null) return;

    for (const [group, method] of [
        ['samples', 'engine'],
        ['projects', 'refineScene'],
        ['projects', 'onRefineProgress'],
        ['agent', 'reviseScenes']
    ]) {
        check(
            `${group}.${method} 暴露在真 preload 上`,
            api[group].includes(method),
            api[group].includes(method) ? '' : `实际有 ${api[group].join(', ')}`
        );
    }
}

/**
 * 本地复刻引擎的真实状态。
 *
 * 不要求它就绪——没配 `INDEX_TTS_URL` 就该如实说没配。
 * 要验的是**这条 IPC 真能往返，而且给的理由是人能照着做的**。
 */
async function checkEngineStatus(page) {
    console.log('\n› 本地音色引擎探活（真 IPC）');
    const status = await page.evaluate(() =>
        window.magicutAPI.voices.samples.engine()
    );

    check(
        'engine() 往返成功',
        typeof status?.ready === 'boolean',
        JSON.stringify(status)
    );
    check(
        status.ready ? '引擎就绪' : '没就绪时给出可照做的理由',
        status.ready || /INDEX_TTS_URL|连不上/.test(status.reason ?? ''),
        status.reason ?? ''
    );

    return status;
}

/**
 * 用**你刚传进去的那段音色**真合成一句，听得见的那种。
 *
 * ## 为什么这一条不收钱也不用 `--live`
 *
 * IndexTTS2 跑在你自己机器上。配了 `INDEX_TTS_URL` 就该顺手验一下——
 * 这是整个自定义音色库唯一真正要紧的问题：**它到底出不出声**。
 * 前面那几条（样本进库了、行显示出来了）都只是铺垫。
 *
 * ## 为什么直接调 IPC 而不是点界面上那个试听按钮
 *
 * 点按钮只能看出"转了个圈然后停了"，看不出**拿回来的是不是真音频**。
 * 这里要的是那段字节：时长大于零、数据不是空壳。
 *
 * 音色 id 的前缀在这儿是手写的，和 `indexTtsVoiceId` 重复了一份——
 * 这是**刻意的**：真写错了的话，这条会红，而那正是我们想知道的事。
 * 从被测代码里 import 它来拼，等于拿同一个错误去验证它自己。
 */
async function checkVoiceSynthesis(page, engine) {
    console.log('\n› 用自定义音色真合成（本地 IndexTTS2）');

    if (!engine?.ready) {
        skip(
            '自定义音色真出声',
            `本地引擎没就绪 —— ${engine?.reason ?? '未知原因'}。` +
                '起好 IndexTTS2 并配上 INDEX_TTS_URL 再跑，这条会自动变严'
        );
        return;
    }

    const result = await page.evaluate(async () => {
        const [sample] = await window.magicutAPI.voices.samples.list();
        if (!sample) return { error: '音色库是空的，上一步没传进去' };
        try {
            const preview = await window.magicutAPI.voices.preview(
                `custom:index-tts2:${sample.id}`
            );
            return {
                durationMs: preview.durationMs,
                bytes: preview.dataUrl.length,
                provider: preview.provider
            };
        } catch (error) {
            return { error: String(error?.message ?? error) };
        }
    });

    if (result.error) {
        check('自定义音色真出声', false, result.error);
        return;
    }

    check(
        '合成往返成功，拿回了真音频',
        result.durationMs > 0 && result.bytes > 1_000,
        `${result.durationMs}ms / ${result.bytes} 字节 / provider=${result.provider}`
    );
    // 走错引擎是最隐蔽的一种失败：有声音，但不是用户那个音色念的
    check(
        '走的是本地引擎，不是悄悄退回了官方音色',
        result.provider === 'index-tts2',
        `provider=${result.provider}`
    );
}

/**
 * 真调一次模型改写分镜文案。
 *
 * ## 为什么只有这一条要 `--live`
 *
 * 它是全脚本唯一会**产生费用**的动作。默认不跑，默认也把凭证清掉了，
 * 所以想跑也跑不出去——两道闸，不靠记性。
 *
 * ## 为什么直接调 IPC 而不是真跑一轮创作
 *
 * 这条 IPC 只要「当前几段文案 + 一句要求」，**不需要图在跑**。
 * 真开一轮创作要先索引素材、调好几次模型、合成整条口播——
 * 为验一次改写花那么多钱说不过去。这样只花一次调用。
 *
 * 断言盯的是那条最容易错的不变量：**交回来的段数必须和发出去的一样**。
 * `modify` 是按下标配对的，错位之后文案张冠李戴，而用户看不出是哪步错的。
 */
async function checkLiveRevise(page) {
    console.log('\n› 模型改写分镜文案（要花钱）');

    if (!live) {
        skip('真调模型改写', '默认不花钱。要验的话加 --live');
        return;
    }

    const scripts = [
        '第一段：开场抛出问题。',
        '第二段：展开讲清楚原因。',
        '第三段：收尾给出建议。'
    ];

    const result = await page.evaluate(async (input) => {
        try {
            return {
                scripts: await window.magicutAPI.videoAgent.reviseScenes(
                    '第二段说得再简短一点，其余不要动',
                    input
                )
            };
        } catch (error) {
            return { error: String(error?.message ?? error) };
        }
    }, scripts);

    if (result.error) {
        check('真调模型改写', false, result.error);
        return;
    }

    check(
        '条数和发出去的一样（错位了这里就该红）',
        result.scripts.length === scripts.length,
        `发 ${scripts.length} 段，回 ${result.scripts.length} 段`
    );
    check(
        '每段都不是空的',
        result.scripts.every((item) => item.trim() !== '')
    );
    check(
        '确实改动了（不是原样抄回来）',
        result.scripts.some((item, i) => item !== scripts[i]),
        result.scripts[1] ?? ''
    );
}

/**
 * 自定义音色库：上传一段真音频，看它变成一条**可选的音色**。
 *
 * 文件对话框是原生的，Playwright 点不动——所以在**主进程里**把
 * `dialog.showOpenDialog` 换掉。换的是对话框，不是业务逻辑：
 * 收样本那一整条（扩展名白名单、大小上限、ffprobe 量时长、复制进 userData、
 * 写索引）走的都是真代码。
 */
async function checkVoiceLibrary(app, page, baseUrl, samplePath, outDir) {
    console.log('\n› 自定义音色库（真文件、真 ffprobe）');

    await app.evaluate(({ dialog }, file) => {
        dialog.showOpenDialog = async () => ({
            canceled: false,
            filePaths: [file]
        });
    }, samplePath);

    await page.goto(`${baseUrl}/#/editor`, {
        waitUntil: 'domcontentloaded'
    });
    await page.getByRole('button', { name: '口播' }).click();

    const panel = page.getByRole('complementary', { name: '口播' });
    await panel.waitFor({ state: 'visible', timeout: 10_000 });

    check('口播面板打开', await panel.isVisible());
    check(
        '上传入口可用（真机上不该是置灰的）',
        await page.getByRole('button', { name: /上传音频样本/ }).isEnabled()
    );

    await page.getByRole('button', { name: /上传音频样本/ }).click();

    // 收样本要过 ffprobe，给它几秒
    const row = page.getByText('我的声音.wav', { exact: false }).first();
    const appeared = await row
        .waitFor({ state: 'visible', timeout: 15_000 })
        .then(() => true)
        .catch(() => false);

    check('上传的样本出现在音色库里', appeared);

    if (appeared) {
        check(
            '计数跟着真实数量走',
            await page
                .getByText('1 个音色')
                .isVisible()
                .catch(() => false)
        );
        // 这是整件事的要点：样本不只是躺在列表里，它是一条**能选来生成**的音色
        check(
            '样本是一条可选音色（有试听与删除）',
            await page
                .getByRole('button', { name: /试听 我的声音\.wav/ })
                .isVisible()
                .catch(() => false)
        );
    }

    // 截图前把那一行滚进视口——证据不在画面里的截图等于没截
    await row.scrollIntoViewIfNeeded().catch(() => undefined);
    await page.screenshot({ path: path.join(outDir, 'voice-panel.png') });
    console.log(`  截图 → ${path.join(outDir, 'voice-panel.png')}`);
}

/**
 * 创作页底部输入框：**没到分镜确认就该禁用，而且说清楚为什么**。
 *
 * 真跑一轮创作要凭证与素材，这里不跑——只验"时候未到"这一档说的话对不对。
 * 那正是这个输入框以前最糟的地方：灰着且不解释。
 */
async function checkComposer(page, baseUrl, outDir) {
    console.log('\n› 创作页输入框');

    /**
     * **只能走真实路径进去。**
     *
     * `/creating` 是守卫路由：没有带着文稿的路由 state 就被弹回工作台
     * （见 `router/index.tsx` 的 `CreatingRoute`）。直接改 hash 进不去，
     * 必须从创作页填文稿、点「创建」。
     */
    await page.goto(`${baseUrl}/#/workspace`, {
        waitUntil: 'domcontentloaded'
    });
    await page.getByRole('tab', { name: '创作' }).click();
    await page
        .getByLabel('视频文稿')
        .fill('端到端自检用的文稿，不会真的跑起来——凭证已经清掉了。');
    await page.getByRole('button', { name: '创建' }).click();

    const bar = page.getByLabel('继续对话');
    const reachable = await bar
        .waitFor({ state: 'visible', timeout: 15_000 })
        .then(() => true)
        .catch(() => false);

    if (!reachable) {
        check('从创作页点「创建」能进到创作进行页', false);
        return;
    }
    check('从创作页点「创建」能进到创作进行页', true);

    check('创作页输入栏在', true);
    check(
        '没到分镜确认时禁用发送',
        !(await page.getByRole('button', { name: '发送' }).isEnabled())
    );
    check(
        '并且说清楚为什么（不是光灰着）',
        await page
            .getByText(/分镜确认|桌面端|做完了|没跑成/)
            .first()
            .isVisible()
            .catch(() => false)
    );

    await page.screenshot({ path: path.join(outDir, 'creating.png') });
    console.log(`  截图 → ${path.join(outDir, 'creating.png')}`);
}

main().catch((error) => {
    console.error(`\n✘ ${error.message}`);
    process.exitCode = 1;
});
