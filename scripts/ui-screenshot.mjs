// 渲染层实跑截图。用于 Pencil 闭环的第三段（代码 ↔ 设计稿一致性校验），
// 也用于任何 UI 改动的交付证据。
//
// 用法：
//   pnpm ui:shot --route=/editor --out=.ui-out/editor.png
//   pnpm ui:shot --route=/editor --out=.ui-out/rail.png --selector='nav[aria-label="素材类型"]'
//   pnpm ui:shot --route=/editor --out=.ui-out/a.png --width=1440 --height=620 --no-build
//
// 参数：
//   --route      hash 路由，默认 /
//   --out        输出 PNG 路径，默认 .ui-out/<route>.png
//   --width      窗口宽，默认 1920
//   --height     窗口高，默认 1094（与 magicut.pen 编辑器 frame 一致）
//   --selector   只截某个元素，CSS 选择器
//   --click      截图前先点击这个选择器，用于验证交互后的状态
//                多步交互用 ' >>> ' 分隔，按顺序点：--click='A >>> B'
//                执行顺序固定为 --fill → --click → --scroll
//   --clip       只截某块区域，格式 x,y,w,h
//   --scroll     截图前先滚动某个容器，格式 选择器@偏移，偏移写 end 表示滚到底
//                例：--scroll='aside[aria-label="音乐"] ul@end'
//   --fill       截图前给输入框灌值，格式 选择器@文本
//                例：--fill='textarea[aria-label="视频文稿"]@很多前端同学在焦虑一件事。'
//   --settle     首屏加载后等待毫秒数，默认 2000
//   --after      交互（fill/click/scroll）之后再等待毫秒数，默认 0。
//                页面里有动画或自动推进时用它等状态稳定
//   --no-build   复用上一次的构建产物，反复截图时用

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const desktopDir = path.join(rootDir, 'apps/desktop');
const buildDir = path.join(rootDir, '.ui-out/build');

const args = new Map(
    process.argv.slice(2).map((arg) => {
        const [key, ...rest] = arg.replace(/^--/, '').split('=');
        return [key, rest.length > 0 ? rest.join('=') : 'true'];
    })
);

const route = args.get('route') || '/';
const out = path.resolve(
    rootDir,
    args.get('out') ||
        `.ui-out/${route.replace(/^\//, '').replace(/\//g, '-') || 'index'}.png`
);

const clip = args.get('clip')
    ? (([x, y, width, height]) => ({ x, y, width, height }))(
          args
              .get('clip')
              .split(',')
              .map((value) => Number.parseInt(value, 10))
      )
    : null;

// 选择器里可能含 @，所以按最后一个 @ 切分
const splitAtLast = (raw, fallback) => {
    const at = raw.lastIndexOf('@');
    return at === -1
        ? { selector: raw, rest: fallback }
        : { selector: raw.slice(0, at), rest: raw.slice(at + 1) };
};

const scroll = args.get('scroll')
    ? (({ selector, rest }) => ({ selector, top: rest }))(
          splitAtLast(args.get('scroll'), 'end')
      )
    : null;

const fill = args.get('fill')
    ? (({ selector, rest }) => ({ selector, value: rest }))(
          splitAtLast(args.get('fill'), '')
      )
    : null;

if (!args.has('no-build')) {
    fs.rmSync(buildDir, { recursive: true, force: true });
    execFileSync(
        'pnpm',
        [
            'exec',
            'vite',
            'build',
            '--config',
            'vite.renderer.config.ts',
            // Forge 打包时自己注入 base: './'，手动构建必须补上，否则 file:// 下资源 404
            '--base',
            './',
            '--outDir',
            buildDir,
            '--emptyOutDir'
        ],
        { cwd: desktopDir, stdio: 'inherit' }
    );
}

execFileSync(
    'pnpm',
    [
        'exec',
        'electron',
        path.join(rootDir, 'scripts/ui-capture.cjs'),
        JSON.stringify({
            buildDir,
            route,
            out,
            clip,
            selector: args.get('selector') || null,
            click: args.get('click') || null,
            scroll,
            fill,
            width: Number.parseInt(args.get('width') || '1920', 10),
            height: Number.parseInt(args.get('height') || '1094', 10),
            // 写成 --after 3000（空格）时这里会拿到 'true'，兜一下避免静默变 NaN
            settleMs: Number.parseInt(args.get('settle') || '2000', 10) || 2000,
            afterMs: Number.parseInt(args.get('after') || '0', 10) || 0
        })
    ],
    { cwd: desktopDir, stdio: 'inherit' }
);
