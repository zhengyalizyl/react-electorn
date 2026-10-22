// Electron 离屏渲染入口，由 scripts/ui-screenshot.mjs 启动，不要直接运行。
// 单独一个 .cjs 文件是因为 Electron 主进程入口必须是 CommonJS。
const fs = require('node:fs');
const path = require('node:path');

const { app, BrowserWindow } = require('electron');

const options = JSON.parse(process.argv[2]);

app.disableHardwareAcceleration();

app.whenReady().then(async () => {
    const win = new BrowserWindow({
        width: options.width,
        height: options.height,
        show: false,
        webPreferences: { offscreen: true }
    });

    await win.loadFile(path.join(options.buildDir, 'index.html'), {
        hash: options.route
    });

    // 等首屏字体与布局稳定，离屏渲染没有 ready-to-show 事件可用
    await new Promise((resolve) => setTimeout(resolve, options.settleMs));

    // 给输入框灌值，用于截交互后的状态。走原生 setter + input 事件，
    // 否则 React 的受控组件收不到变更。
    if (options.fill) {
        const filled = await win.webContents.executeJavaScript(
            `(() => {
                const el = document.querySelector(${JSON.stringify(options.fill.selector)});
                if (!el) return false;
                const proto = el instanceof HTMLTextAreaElement
                    ? HTMLTextAreaElement.prototype
                    : HTMLInputElement.prototype;
                Object.getOwnPropertyDescriptor(proto, 'value')
                    .set.call(el, ${JSON.stringify(options.fill.value)});
                el.dispatchEvent(new Event('input', { bubbles: true }));
                return true;
            })()`
        );

        if (!filled) {
            throw new Error(`填值选择器未命中任何元素：${options.fill.selector}`);
        }

        await new Promise((resolve) => setTimeout(resolve, 300));
    }

    // 需要截交互后的状态时，先点一下再等一小会儿让重渲染落定。
    // 多步交互用 ' >>> ' 分隔多个选择器，按顺序点。
    for (const selector of options.click ? options.click.split(' >>> ') : []) {
        const clicked = await win.webContents.executeJavaScript(
            `(() => {
                const el = document.querySelector(${JSON.stringify(selector)});
                if (!el) return false;
                el.click();
                return true;
            })()`
        );

        if (!clicked) {
            throw new Error(`点击选择器未命中任何元素：${selector}`);
        }

        await new Promise((resolve) => setTimeout(resolve, 400));
    }

    // 滚动到底才能看到列表末尾与滚动条终点，离屏窗口没法手动滚
    if (options.scroll) {
        const scrolled = await win.webContents.executeJavaScript(
            `(() => {
                const el = document.querySelector(${JSON.stringify(options.scroll.selector)});
                if (!el) return false;
                el.scrollTop = ${JSON.stringify(options.scroll.top)} === 'end'
                    ? el.scrollHeight
                    : Number(${JSON.stringify(options.scroll.top)});
                return true;
            })()`
        );

        if (!scrolled) {
            throw new Error(
                `滚动选择器未命中任何元素：${options.scroll.selector}`
            );
        }

        await new Promise((resolve) => setTimeout(resolve, 200));
    }

    // 交互后还有动画或自动推进时，再等一会儿
    if (options.afterMs > 0) {
        await new Promise((resolve) => setTimeout(resolve, options.afterMs));
    }

    let rect = options.clip;

    if (options.selector) {
        rect = await win.webContents.executeJavaScript(
            `(() => {
                const el = document.querySelector(${JSON.stringify(options.selector)});
                if (!el) return null;
                const r = el.getBoundingClientRect();
                return {
                    x: Math.round(r.x),
                    y: Math.round(r.y),
                    width: Math.round(r.width),
                    height: Math.round(r.height)
                };
            })()`
        );

        if (!rect) {
            throw new Error(`选择器未命中任何元素：${options.selector}`);
        }
    }

    const image = rect
        ? await win.webContents.capturePage(rect)
        : await win.webContents.capturePage();

    fs.mkdirSync(path.dirname(options.out), { recursive: true });
    fs.writeFileSync(options.out, image.toPNG());

    const size = image.getSize();
    process.stdout.write(`${options.out} ${size.width}x${size.height}\n`);

    app.quit();
});

app.on('window-all-closed', () => app.quit());
