import ActivityLine from '@/renderer/components/create-message/ActivityLine';
import AnalysisCard from '@/renderer/components/create-message/AnalysisCard';
import {
    MatchApproval,
    RequirementApproval,
    SceneApproval
} from '@/renderer/components/create-message/Approvals';
import AssistantText from '@/renderer/components/create-message/AssistantText';
import MatchTable from '@/renderer/components/create-message/MatchTable';
import OverviewCard from '@/renderer/components/create-message/OverviewCard';
import PendingBlock from '@/renderer/components/create-message/PendingBlock';
import RequestCard from '@/renderer/components/create-message/RequestCard';
import RequirementTable from '@/renderer/components/create-message/RequirementTable';
import SceneList from '@/renderer/components/create-message/SceneList';
import StageSteps from '@/renderer/components/create-message/StageSteps';
import StreamingText from '@/renderer/components/create-message/StreamingText';
import UserBubble from '@/renderer/components/create-message/UserBubble';
import type { RunMessage } from '@/renderer/data/run-messages';
import type { StageView } from '@/renderer/data/run-stages';
import type { UseAgentRun } from '@/renderer/data/use-agent-run';

/**
 * 把聊天记录摊成界面（设计稿 W8bPLG）。
 *
 * ## 待确认的消息底下才挂控件
 *
 * 一条中断消息有两副面孔：**正在等你**的时候带确认按钮，
 * 答复过之后只剩内容。判据是消息自己的 `pending`（见 run-messages.ts），
 * 不是"它是不是最后一条"——图里有回环，同类消息会出现两次。
 */

interface MessageListProps {
    messages: RunMessage[];
    stages: StageView[];
    run: UseAgentRun;
    /** 选中的素材文件名，显示在需求卡里 */
    materials: string[];
    /** 本次用的音色，概览里要报 */
    voiceId: string | null;
    onOpenProject: () => void;
}

export default function MessageList({
    messages,
    stages,
    run,
    materials,
    voiceId,
    onOpenProject
}: MessageListProps) {
    return (
        <ol aria-label="创作消息" className="flex w-full flex-col gap-6">
            {messages.map((message) => (
                <li key={message.key} className="w-full">
                    {renderMessage(
                        message,
                        stages,
                        run,
                        materials,
                        voiceId,
                        onOpenProject
                    )}
                </li>
            ))}
        </ol>
    );
}

function renderMessage(
    message: RunMessage,
    stages: StageView[],
    run: UseAgentRun,
    materials: string[],
    voiceId: string | null,
    onOpenProject: () => void
) {
    switch (message.kind) {
        case 'request':
            return (
                <RequestCard
                    script={message.script}
                    voiceId={message.voiceId}
                    materials={materials}
                />
            );

        case 'streaming':
            return <StreamingText text={message.text} live={message.live} />;

        case 'text':
            return <AssistantText text={message.text} tone={message.tone} />;

        case 'stages':
            return (
                <div className="flex w-full flex-col gap-4">
                    <StageSteps stages={stages} />
                    {/* 还在跑就报当前节点：四个阶段太粗，长节点期间会像卡死 */}
                    {run.phase === 'running' ? (
                        <ActivityLine node={run.node} />
                    ) : null}
                </div>
            );

        case 'analysis':
            return (
                <AnalysisCard
                    inputKind={message.inputKind}
                    outline={message.outline}
                    theme={message.theme}
                    audience={message.audience}
                    tone={message.tone}
                    keyPoints={message.keyPoints}
                    materialFit={message.materialFit}
                />
            );

        case 'requirements':
            // 待确认时整块换色：图真的停在这里等答复，
            // 和普通消息长一个样的话，用户会以为它还在跑
            return message.pending ? (
                <PendingBlock>
                    <RequirementTable rows={message.rows} />
                    <RequirementApproval run={run} />
                </PendingBlock>
            ) : (
                <RequirementTable rows={message.rows} />
            );

        case 'scenes':
            return message.pending ? (
                <PendingBlock>
                    <SceneList scenes={message.scenes} />
                    <SceneApproval run={run} />
                </PendingBlock>
            ) : (
                <SceneList scenes={message.scenes} />
            );

        case 'matches':
            return message.pending ? (
                <PendingBlock>
                    <MatchTable matches={message.matches} />
                    <MatchApproval run={run} />
                </PendingBlock>
            ) : (
                <MatchTable matches={message.matches} />
            );

        case 'overview':
            return (
                <OverviewCard
                    sceneCount={run.scenes.length}
                    matched={
                        run.matches.filter((match) => !match.abandoned).length
                    }
                    voiceId={voiceId}
                    onOpenProject={onOpenProject}
                />
            );

        case 'error':
            // 主进程的错误里可能带换行（比如缺凭证时那段配置示例），
            // 不加 pre-line 会被压成一行，照着抄都抄不对
            return (
                <p className="w-full text-ed-lg leading-[1.6] whitespace-pre-line text-ed-accent">
                    创作失败：{message.message}
                </p>
            );

        case 'reply':
            return <UserBubble text={message.text} />;

        default:
            return null;
    }
}
