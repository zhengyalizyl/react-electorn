import { useEffect, useRef } from 'react';

import Composer from '@/renderer/components/create-message/Composer';
import MessageList from '@/renderer/components/create-message/MessageList';
import OutlineCard from '@/renderer/components/create-message/OutlineCard';
import { initialMessages } from '@/renderer/data/run-messages';
import { stagesOf } from '@/renderer/data/run-stages';
import type { RunPhase } from '@/renderer/data/use-agent-run';
import { useAgentRun } from '@/renderer/data/use-agent-run';
import { useMediaLibrary } from '@/renderer/data/use-media-library';

/**
 * 创作进行页。点「创建」之后进的就是这一页。
 *
 * 对应 magicut-demo.pen 的 frame W8bPLG（妙剪创作消息页）：
 * 左边是**一条聊天记录**——你的需求卡、助手的每一句结论、分镜与素材表、
 * 你在中断点的确认气泡、跑完的概览；右上角钉着「执行目录」，底部是输入栏。
 *
 * 同一页还有一张更早的变体稿 OrZJP（准备阶段），配色与结构略有出入，
 * **以 W8bPLG 为准**——它是内容最全的那张。
 *
 * ## 设计稿里没照抄的几处
 *
 * 1. **窗口标题栏与红黄绿灯**：那是稿子里画的 macOS 窗口装饰，
 *    真机上由 Electron 的原生窗口提供，再画一条就是两层标题栏。
 * 2. **助手说的话**：稿子写的是「我来分析你的文稿…」这类示意句，
 *    照抄会让人以为系统真做了那几件事。改成智能体自己报上来的事件。
 * 3. **「待确认」改成「待执行」**：我们多了一种真实存在的「等你确认」
 *    （图停在中断点），和「待确认」一字之差意思却相反，并排放会看错。
 * 4. **输入栏禁用**：P1 没有多轮对话能力，能打字却发不出去比灰着更糟。
 *
 * ## 运行由这一页发起
 *
 * 文稿和音色是从上一页通过路由 state 带过来的，**这一页自己调 `start`**。
 * 换种做法（上一页发起、这一页只订阅）会遇到一个真问题：
 * `useAgentRun` 的状态在组件里，跳页时上一页卸载，进度就断了。
 */

export interface CreatingHandoff {
    script: string;
    voiceId?: string;
}

interface CreatingPageProps {
    handoff: CreatingHandoff;
    /** 回创作页重新填文稿 */
    onBack: () => void;
    /**
     * 跑完了进编辑器。
     *
     * 参数是工程目录名——路由按它定位（工程 id 在 JSON 里，
     * 而路由要能在不读文件的情况下跳转）。
     */
    onDone: (dirName: string) => void;
}

/**
 * 落盘路径 → 工程目录名。
 *
 * `…/projects/run_abc/project.json` → `run_abc`。
 * 路由用目录名定位，不用工程 id——id 在 JSON 里，跳转时还没读文件。
 */
export function dirNameOf(savedPath: string): string {
    const parts = savedPath.split(/[\\/]/).filter(Boolean);
    return parts[parts.length - 2] ?? '';
}

/** 设计稿里的时间戳是「07/29 20:42」，这里用真的当前时间 */
function nowStamp(): string {
    const at = new Date();
    const pad = (value: number) => String(value).padStart(2, '0');
    return `${pad(at.getMonth() + 1)}/${pad(at.getDate())} ${pad(at.getHours())}:${pad(at.getMinutes())}`;
}

export default function CreatingPage({
    handoff,
    onBack,
    onDone
}: CreatingPageProps) {
    const run = useAgentRun();
    const media = useMediaLibrary();
    // StrictMode 下 effect 会跑两遍，不挡住就会发起两次创作——两次都真的花钱
    const started = useRef(false);
    const stamp = useRef(nowStamp());

    useEffect(() => {
        if (started.current || !run.available) return;
        started.current = true;
        void run.start(handoff.script, handoff.voiceId);
    }, [handoff, run]);

    /**
     * 现在为什么不能在这儿提要求。
     *
     * **每一档都说得具体**：笼统一句"暂时不可用"只会让人反复去点它。
     * 等得到的那几档要讲清楚"等到什么时候"，等不到的那档要直说。
     */
    const composerHint = (phase: RunPhase, available: boolean): string => {
        if (!available) return '创作只能在桌面端运行';

        switch (phase) {
            case 'awaiting_requirements':
                return '需求文档这一步只能放行或回上一页改提示词；到了分镜确认就能在这儿提要求';
            case 'awaiting_matches':
                return '素材确认是在候选里挑，不走文字；要改文案得在分镜确认那一步';
            case 'running':
                return '正在跑，等它停到分镜确认就能在这儿提要求';
            case 'finished':
                return '这条片子已经做完了，接着改请在编辑器里说';
            case 'failed':
                return '这一轮没跑成，改要求请回创作页重开一条';
            default:
                return '等跑到分镜确认那一步，就能在这儿用一句话改文案';
        }
    };

    // 第四步做完就进编辑器：片子已经躺在那儿了，停在聊天页还要用户再点一下
    const jumped = useRef(false);
    useEffect(() => {
        if (run.phase !== 'finished' || run.savedPath === null) return;
        if (jumped.current) return;
        jumped.current = true;
        onDone(dirNameOf(run.savedPath));
    }, [run.phase, run.savedPath, onDone]);

    const stages = stagesOf({ phase: run.phase, node: run.node });
    const materials = (media.status?.indexed ?? []).map((file) => file.name);
    // 没有桥时（浏览器、ui:shot）跑不起来，但需求卡该显示——
    // 那条消息的内容是上一页交过来的，和有没有桥无关
    const messages =
        run.messages.length > 0 ? run.messages : initialMessages(handoff);

    return (
        <main
            aria-label="创作进行中"
            className="flex min-w-0 flex-1 gap-10 overflow-y-auto bg-msg-bg px-10 pt-[72px] pb-16 font-ed scrollbar-ed"
        >
            {/* 对话列：设计稿是 873 定宽、居中偏左。窗口窄了要能收，所以配 max-w */}
            <div className="mx-auto flex w-[873px] max-w-full flex-col">
                <div className="mb-6 flex items-center justify-between">
                    <button
                        type="button"
                        onClick={onBack}
                        className="cursor-pointer text-ed-md text-ed-text-2 hover:text-ed-text"
                    >
                        ← 返回创作页
                    </button>
                    <span className="text-ed-md text-ed-text-2">
                        {stamp.current}
                    </span>
                </div>

                <MessageList
                    messages={messages}
                    stages={stages}
                    run={run}
                    materials={materials}
                    voiceId={handoff.voiceId ?? null}
                    onOpenProject={() => onDone(dirNameOf(run.savedPath ?? ''))}
                />

                {!run.available ? (
                    <p className="mt-8 text-ed-lg text-msg-text-4">
                        创作只能在桌面端运行
                    </p>
                ) : null}

                {/*
                    这个输入框**只在分镜确认那一刻活着**：图里只有那个中断点
                    能用一句话改（它的契约带着 modify + scripts），而且图停在
                    那儿等人点头，再往后每一步都要花钱。

                    其余时候说清楚现在为什么不能用——只是灰着的话，用户不知道
                    是坏了还是时候未到。
                */}
                <div className="mt-8">
                    <Composer
                        busy={run.revising}
                        error={run.reviseError}
                        {...(run.phase === 'awaiting_scenes'
                            ? { onSubmit: run.reviseScenes }
                            : {
                                  disabledReason: composerHint(
                                      run.phase,
                                      run.available
                                  )
                              })}
                    />
                </div>
            </div>

            <OutlineCard stages={stages} />
        </main>
    );
}
