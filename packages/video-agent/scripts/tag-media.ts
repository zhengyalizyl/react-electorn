/**
 * 开发用的打标命令。跑真实索引库，看进度、看结果、看花了多少 token。
 *
 *   pnpm --filter @magicut-react-demo/video-agent tag -- --limit 5
 *   pnpm --filter @magicut-react-demo/video-agent tag -- --retry-failed
 *   pnpm --filter @magicut-react-demo/video-agent tag -- --search 办公
 *
 * 不带 `ARK_API_KEY` 时自动走 Mock，只验证管线通不通，不产生任何费用。
 *
 * ⚠️ 凭证只从环境变量读，**不许写进任何文件**。
 */

import { config as loadDotenv } from 'dotenv';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { MediaIndexDb } from '@magicut-react-demo/media-index';

import type { ModelProvider } from '@/llm';
import { ArkChatModelProvider, loadLlmConfig, MockModelProvider } from '@/llm';
import type { TagEvent } from '@/tagging';
import { runTaggingPipeline } from '@/tagging';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, '../../..');

// 凭证从仓库根的 .env 读。命令行和桌面端要用同一份配置——
// 不然会出现"界面上能跑、命令行说没配凭证"这种自相矛盾的现象
loadDotenv({ path: path.join(REPO_ROOT, '.env'), quiet: true });

function argOf(name: string): string | undefined {
    const index = process.argv.indexOf(`--${name}`);
    return index === -1 ? undefined : process.argv[index + 1];
}

const hasFlag = (name: string): boolean => process.argv.includes(`--${name}`);

/* eslint-disable no-console */
function render(event: TagEvent): void {
    switch (event.type) {
        case 'tagging_started':
            console.log(`待打标片段：${event.total}`);
            break;
        case 'segment_started':
            process.stdout.write(
                `\r[${event.done}/${event.total}] ${event.segmentId}`.padEnd(60)
            );
            break;
        case 'segment_tagged':
            console.log(
                `\n  ✓ ${event.segmentId}  (输入 ${event.usage.promptTokens} / 输出 ${event.usage.completionTokens} token)`
            );
            console.log(`    ${event.description}`);
            break;
        case 'segment_failed':
            console.log(`\n  ✗ ${event.segmentId}：${event.message}`);
            break;
        case 'segment_skipped':
            console.log(`\n  – ${event.segmentId}：${event.reason}`);
            break;
        case 'tagging_finished': {
            const s = event.summary;
            console.log(
                `\n完成：打标 ${s.tagged}、失败 ${s.failed}、跳过 ${s.skipped}`
            );
            console.log(
                `用量：输入 ${s.usage.promptTokens} / 输出 ${s.usage.completionTokens} / ` +
                    `其中思考 ${s.usage.reasoningTokens} token`
            );
            if (s.tagged > 0) {
                console.log(
                    `均摊每片段：输入 ${Math.round(s.usage.promptTokens / s.tagged)} / ` +
                        `输出 ${Math.round(s.usage.completionTokens / s.tagged)} token`
                );
            }
            break;
        }
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
    const outDir = resolveFromRepo(argOf('out') ?? '.media-index');
    const db = MediaIndexDb.open(path.join(outDir, 'index.db'));

    const config = loadLlmConfig();
    const provider: ModelProvider =
        config.provider === 'ark'
            ? new ArkChatModelProvider({ config })
            : new MockModelProvider({
                  responders: {
                      AssetTagger: {
                          description: '（Mock）未接真实模型，这是占位描述',
                          tags: ['mock'],
                          subjectCenterX: 0.5,
                          subjectCenterY: 0.5,
                          orientation: 'landscape',
                          hasFaces: false
                      }
                  }
              });

    console.log(
        `provider = ${provider.name}` +
            (config.provider === 'ark'
                ? `  model = ${config.model}  method = ${config.methods.join(' → ')}`
                : '（没有 ARK_API_KEY，走 Mock，不产生费用）')
    );

    try {
        await runTaggingPipeline({
            db,
            provider,
            maxKeyframes: Number(argOf('max-keyframes') ?? 3),
            concurrency: Number(argOf('concurrency') ?? 2),
            limit: Number(argOf('limit') ?? 100_000),
            retryFailed: hasFlag('retry-failed'),
            onEvent: render
        });

        console.log('库统计：', db.stats());

        const query = argOf('search');
        if (query !== undefined) {
            console.log(`\n检索「${query}」：`);
            for (const hit of db.search(query, { limit: 10 })) {
                console.log(
                    `  ${hit.score.toFixed(3)}  ${path.basename(hit.path)}\n` +
                        `        ${hit.description ?? '(未打标)'}`
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
