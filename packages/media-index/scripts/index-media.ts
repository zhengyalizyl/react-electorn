/**
 * 开发用的索引命令。跑真实素材目录，看进度、看结果、试检索。
 *
 *   pnpm --filter @magicut-react-demo/media-index index          # 扫 <仓库根>/sample
 *   pnpm --filter @magicut-react-demo/media-index index -- --root ~/Movies/MiaoMa素材
 *   pnpm --filter @magicut-react-demo/media-index index -- --search 办公室
 *
 * 素材放哪：仓库根的 `sample/`（已在 .gitignore 里）适合开发调试；
 * 正式素材放本机稳定目录，例如 `~/Movies/MiaoMa素材/项目名/raw/`。
 * **不要放进 apps/、packages/ 这些源码目录，也不要提交进 git。**
 */

import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { MediaIndexDb } from '@/db';
import { DEFAULT_CONCURRENCY, runIndexPipeline } from '@/pipeline';
import type { IndexEvent } from '@/types';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, '../../..');

function argOf(name: string): string | undefined {
    const index = process.argv.indexOf(`--${name}`);
    return index === -1 ? undefined : process.argv[index + 1];
}

// 这是命令行工具，输出就是它的产品，所以这里放开 no-console
/* eslint-disable no-console */
function render(event: IndexEvent): void {
    switch (event.type) {
        case 'scan_started':
            console.log(`扫描 ${event.roots.join('、')}`);
            break;
        case 'scan_finished':
            console.log(
                `发现 ${event.found} 个：新增 ${event.added}、变更 ${event.changed}、清理 ${event.pruned}`
            );
            break;
        case 'file_started':
            process.stdout.write(
                `\r[${event.done}/${event.total}] ${path.basename(event.path).slice(0, 50)}`.padEnd(
                    72
                )
            );
            break;
        case 'file_failed':
            console.log(
                `\n  ✗ ${path.basename(event.path)}（${event.stage}）：${event.message}`
            );
            break;
        case 'finished':
            console.log(`\n完成：${JSON.stringify(event.summary)}`);
            break;
        default:
            break;
    }
}

/**
 * 相对路径按**仓库根**解析，不按 cwd。
 *
 * `pnpm --filter` 会把 cwd 切到包目录，所以 `--root sample` 按 cwd 解析会指向
 * `packages/xxx/sample`——一个不存在的目录，扫出 0 个文件，还不报错。
 */
function resolveFromRepo(value: string): string {
    return path.isAbsolute(value) ? value : path.resolve(REPO_ROOT, value);
}

async function main(): Promise<void> {
    const root = resolveFromRepo(
        argOf('root') ?? process.env['MEDIA_ROOTS'] ?? 'sample'
    );
    const outDir = resolveFromRepo(argOf('out') ?? '.media-index');
    await mkdir(outDir, { recursive: true });

    const db = MediaIndexDb.open(path.join(outDir, 'index.db'));
    try {
        await runIndexPipeline({
            roots: [root],
            db,
            keyframeDir: path.join(outDir, 'keyframes'),
            // 跟着 DEFAULT_CONCURRENCY（核数一半）走，别在这儿另写一个数：
            // 写死 4 在四核机器上就是满核跑，而 ffmpeg 自己还是多线程的
            concurrency: Number(argOf('concurrency') ?? DEFAULT_CONCURRENCY),
            onEvent: render
        });

        console.log('库统计：', db.stats());

        const query = argOf('search');
        if (query !== undefined) {
            const hits = db.search(query, { limit: 10 });
            console.log(`\n检索「${query}」命中 ${hits.length} 条：`);
            for (const hit of hits) {
                console.log(
                    `  ${hit.score.toFixed(3)}  ${(hit.durationMs / 1000).toFixed(1)}s  ` +
                        `${hit.width}×${hit.height}  ${path.basename(hit.path)}` +
                        (hit.description ? `\n        ${hit.description}` : '')
                );
            }
        }
    } finally {
        db.close();
    }
}

main().catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
});
