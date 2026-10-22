/**
 * 开发用的创作命令：脱离 Electron 跑一遍完整的图。
 *
 *   pnpm --filter @magicut-react-demo/video-agent agent -- --prompt "讲讲前端如何转型 AI"
 *   pnpm --filter @magicut-react-demo/video-agent agent -- --index <索引库> --out <工程目录>
 *
 * 命令名不能叫 `create`——那是 pnpm 的内置命令，会被它抢走。
 *
 * 不带 `ARK_API_KEY` 时自动走 Mock，只验证管线通不通，不产生任何费用。
 *
 * ## 为什么需要它
 *
 * B10 的 runner 绑在 Electron 的 IPC 上，**图本身没法单独跑**。
 * 排查"是图的问题还是界面的问题"时，没有这个命令就只能靠界面猜。
 *
 * 两个中断点在这里一律自动放行——要人工确认的流程走界面，这个命令只管跑通。
 *
 * ⚠️ 凭证只从环境变量读，**不许写进任何文件**。
 */

import { config as loadDotenv } from 'dotenv';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { Command } from '@langchain/langgraph';
import { MediaIndexDb } from '@magicut-react-demo/media-index';
import { validateProject } from '@magicut-react-demo/video-project';

import type { GraphDeps, GraphEvent } from '@/graph';
import { buildAgentGraph, SqliteWasmSaver } from '@/graph';
import type { ModelProvider } from '@/llm';
import { ArkChatModelProvider, loadLlmConfig, MockModelProvider } from '@/llm';
import { DEFAULT_VOICE_ID, makeVoiceProvider } from '@/tts';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, '../../..');

// 凭证从仓库根的 .env 读。命令行和桌面端要用同一份配置——
// 不然会出现"界面上能跑、命令行说没配凭证"这种自相矛盾的现象
loadDotenv({ path: path.join(REPO_ROOT, '.env'), quiet: true });

function argOf(name: string): string | undefined {
    const index = process.argv.indexOf(`--${name}`);
    return index === -1 ? undefined : process.argv[index + 1];
}

/* eslint-disable no-console */
function render(event: GraphEvent): void {
    switch (event.type) {
        case 'node_start':
            process.stdout.write(`\n▶ ${event.node}\n`);
            break;
        case 'progress':
            console.log(
                `    [${event.done}/${event.total}] ${event.label ?? ''}`
            );
            break;
        case 'partial': {
            // 流式：原地重写同一行，看得见字在长出来。
            // 只留最后 70 个字——终端一行放不下一整段
            const tail = event.text.replace(/\s+/g, ' ').slice(-70);
            process.stdout.write(`\r    ✎ ${tail.padEnd(72)}`);
            break;
        }
        case 'decision':
            console.log(`  · ${event.summary}`);
            break;
        case 'warning':
            console.log(`  ⚠ ${event.node}：${event.message}`);
            break;
        case 'awaiting_input':
            console.log(`  ⏸ ${event.node}（命令行里自动放行）`);
            break;
        case 'finished':
            console.log(`\n✓ 已保存：${event.savedPath}`);
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
    const prompt = argOf('prompt') ?? '做一条讲前端如何转型做 AI 的口播短片';
    const indexDb = resolveFromRepo(argOf('index') ?? '.media-index/index.db');
    const outRoot = resolveFromRepo(argOf('out') ?? '.projects');
    const runId = `run_${Date.now().toString(36)}`;

    const config = loadLlmConfig();
    const model: ModelProvider =
        config.provider === 'ark'
            ? new ArkChatModelProvider({ config })
            : new MockModelProvider();

    console.log(
        `provider = ${model.name}` +
            (config.provider === 'ark'
                ? `  model = ${config.model}  method = ${config.methods.join(' → ')}`
                : '（没有 ARK_API_KEY，走 Mock，不产生费用）')
    );
    console.log(`索引库 = ${indexDb}`);
    console.log(`提示词 = ${prompt}\n`);

    const db = MediaIndexDb.open(indexDb);
    const saver = SqliteWasmSaver.open(path.join(outRoot, 'checkpoints.db'));
    const projectDir = path.join(outRoot, runId);

    // 两处都要用，各算一遍迟早会出现"发给引擎的"和"写进工程的"不是同一个
    const voiceId = process.env['TTS_VOICE'] ?? DEFAULT_VOICE_ID;

    const deps: GraphDeps = {
        db,
        model,
        /**
         * 走分流入口，和桌面端那三条路一致。
         *
         * 这里**不传 `referenceOf`**：音色库在 Electron 的 userData 下，
         * 命令行拿不到。于是 `TTS_VOICE` 配成自定义音色时会被当场拦下并说清楚，
         * 而不是像以前那样悄悄退回官方音色、跑完才发现声音不对。
         */
        tts: makeVoiceProvider({
            outDir: path.join(outRoot, 'audio'),
            voiceId
        }),
        voiceId,
        projectDir,
        onEvent: render
    };

    try {
        const graph = buildAgentGraph({ deps, checkpointer: saver });
        const cfg = {
            configurable: { thread_id: runId },
            // 图里有 repair 环，默认 25 步不够
            recursionLimit: 80
        };

        await graph.invoke({ runId, prompt }, cfg);
        // 中断点自动放行，直到图跑完为止
        for (let i = 0; i < 12; i += 1) {
            const state = await graph.getState(cfg);
            if (state.next.length === 0) break;
            await graph.invoke(
                new Command({ resume: { action: 'approve' } }),
                cfg
            );
        }

        const final = await graph.getState(cfg);
        const project = final.values.project;
        if (!project) {
            console.log('\n✗ 没有产出工程');
            process.exitCode = 1;
            return;
        }

        const issues = validateProject(project);
        console.log(
            `\n校验：${issues.length === 0 ? '全部通过' : issues.length + ' 条问题'}`
        );
        for (const issue of issues) console.log(`  ✗ ${issue.message}`);

        console.log(
            `分镜 ${project.scenes.length} 段，总长 ${(project.canvas.durationMs / 1000).toFixed(1)}s`
        );
        for (const track of project.tracks) {
            console.log(`  ${track.kind}：${track.clips.length} 个片段`);
        }
        console.log('\n决策留痕：');
        for (const decision of project.ai.decisions) {
            console.log(`  ${decision.sceneId ?? '-'} → ${decision.chosen}`);
            console.log(`    ${decision.reason}`);
        }
        if (project.ai.failures.length > 0) {
            console.log('\n放弃的分镜：');
            for (const failure of project.ai.failures) {
                console.log(`  ${failure.sceneId ?? '-'}：${failure.reason}`);
            }
        }
    } finally {
        saver.close();
        db.close();
    }
}

main().catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
});
