import { useEffect, useRef, useState } from 'react';

import type {
    SubtitleStyle,
    VideoProject
} from '@magicut-react-demo/video-project';
import {
    sceneIndexAt,
    splitBlockedReason,
    splitSceneAt
} from '@magicut-react-demo/video-project';

import ConfigPanel from '@/renderer/components/editor/ConfigPanel';
import type { SaveState } from '@/renderer/components/editor/EditorHeader';
import EditorHeader from '@/renderer/components/editor/EditorHeader';
import type { EditorTab } from '@/renderer/components/editor/IconRail';
import IconRail from '@/renderer/components/editor/IconRail';
import PreviewPanel from '@/renderer/components/editor/PreviewPanel';
import ScriptSidebar from '@/renderer/components/editor/ScriptSidebar';
import Timeline from '@/renderer/components/editor/Timeline';
import { applyEdits } from '@/renderer/data/apply-edits';
import { CURRENT_SCENE_INDEX } from '@/renderer/data/editor-project';
import type { SubtitleSettings } from '@/renderer/data/subtitle-style';
import {
    baseStyleEntryOf,
    resolveSubtitleStyle,
    sameSubtitleStyle,
    settingsFromProject
} from '@/renderer/data/subtitle-style';
import { useAutoSave } from '@/renderer/data/use-auto-save';
import { useEditHistory } from '@/renderer/data/use-edit-history';
import { useExport } from '@/renderer/data/use-export';
import { usePreview } from '@/renderer/data/use-preview';
import { useRefineScene } from '@/renderer/data/use-refine-scene';
import { useVoiceRegenerate } from '@/renderer/data/use-voice-regenerate';
import type { VoiceParams } from '@/renderer/data/voice-fixtures';
import { speedToRate } from '@/renderer/data/voice-fixtures';
import {
    percentToGainDb,
    voiceGainOf,
    voiceParamsFromProject
} from '@/renderer/data/voice-settings';

interface EditorPageProps {
    /**
     * 真实工程。
     *
     * 不传时整页退回**示例工程**——`/editor` 无 id 就是设计稿预览。
     * 这条分支刻意保留：没有它，设计稿比对就得先造一个工程。
     */
    project?: VideoProject | undefined;
    /** 工程目录名。预览的媒体 URL 靠它定位（渲染层只说 id，不说路径） */
    projectId?: string | undefined;
    /** 加载中或失败时显示在标题位置的提示 */
    notice?: string | undefined;
    /** 点左上角品牌区回首页，由路由层注入 */
    onHome?: (() => void) | undefined;
    /**
     * 记一条针对当前分镜的修改要求。由路由层注入（它才知道工程目录名）。
     * 不传时输入框只读——没有去处的输入不如不给。
     */
    onRequest?:
        | ((input: { sceneId: string | null; text: string }) => Promise<void>)
        | undefined;
    /**
     * 进来时停在哪个面板。
     *
     * 刚跑完一条片子过来时是「口播」——那是最该先听一遍的东西，
     * 画面与字幕都是照着它排的。平时打开工程还是默认「画面」。
     */
    initialTab?: EditorTab | undefined;
    /**
     * 把改好的字幕样式写进工程。由路由层注入（它才知道工程目录名）。
     *
     * 不传时字幕设置只活在这一次会话里——关掉工程再打开就变回去了。
     * 这不是"坏掉"，是浏览器/设计稿预览里本来就无处可写；
     * 真机上路由一定会传。
     */
    onSubtitleStyleSave?:
        | ((input: { styleId: string; style: SubtitleStyle }) => Promise<void>)
        | undefined;
    /**
     * 把口播音量写进工程（配音轨每条片段的 `gainDb`）。
     *
     * 不传时音量只影响这一次预览。**语速没有对应的回调**——
     * 它改的是合成不是播放，真要让成片变速得重新合成全部配音再重排时间线，
     * 写进工程等于宣称成片也变速了。
     */
    onVoiceGainSave?:
        | ((input: { gainDb: number }) => Promise<void>)
        | undefined;
    /**
     * 整份工程写回去。改结构（分割）只能这么存——它同时动四条轨道、
     * 所有分镜的起点与序号、还有画布总时长，按字段存不下来。
     *
     * 不传时分割只活在这一次会话里。
     */
    onProjectSave?: ((next: VideoProject) => Promise<void>) | undefined;
}

/**
 * 落盘的防抖窗口。
 *
 * 拖一次滑杆连发几十个值，每个都写一次 `project.json` 是在拿磁盘换手感。
 * 停手之后再写，并且**只写最后那一下**——中间那些值用户根本没打算要。
 */
const SAVE_DELAY_MS = 600;

/**
 * 编辑器里**用户能改、且会影响成片**的那几样。
 *
 * 撤销栈存的就是它：按 Cmd+Z 的人不关心上一步改的是字幕还是音量，
 * 分成两个历史栈只会让"上一步"这个概念变得不确定。
 */
export interface EditorEdits {
    subtitle: SubtitleSettings;
    voice: VoiceParams;
    /**
     * 改过结构的那份工程。`null` = 没动过结构，用传进来的那份。
     *
     * 分割这类操作动的是**工程本身**（分镜、四条轨道、画布时长），
     * 不是几个界面开关。放进同一块可编辑状态里，撤销才能一视同仁地覆盖它——
     * 按 Cmd+Z 的人不关心上一步改的是字幕颜色还是切了一刀。
     */
    project: VideoProject | null;
    /**
     * 这份工程**主进程已经写过盘了**。
     *
     * 「生成口播稿」是在主进程里合成 + 重排 + 校验 + 落盘一气呵成的
     * （中间那个"换了音频还没重排"的状态不合法，不能留在盘上）。
     * 拿回来之后再自动存一次，只会把同一份内容重复写一遍。
     *
     * 撤销回到更早的状态时这个标记要清掉——那时候盘上那份和界面上就不一样了，
     * 得重新存。
     */
    savedByMain?: boolean | undefined;
}

/**
 * 编辑器页。
 *
 * 刻意不读路由参数、也不自己发起加载：解析 :projectId 与拉数据都交给路由层，
 * 这样这个组件在测试里可以脱离 Router 直接渲染。
 */
export default function EditorPage({
    project,
    projectId,
    notice,
    onHome,
    initialTab,
    onRequest,
    onSubtitleStyleSave,
    onVoiceGainSave,
    onProjectSave
}: EditorPageProps) {
    // 选中的素材类型只活在这一页里：demo 仓库还没有 IPC 偏好存储，
    // 接上之后把这行换成读写偏好的 hook 即可，其余组件不用动。
    // 刚跑完一条片子进来时停在「口播」：那是最该先听一遍的东西，
    // 画面和字幕都是照着它排的
    const [tab, setTab] = useState<EditorTab>(initialTab ?? 'visual');
    /**
     * 当前选中的分镜。
     *
     * 侧栏、预览、右侧配置区共用它——之前它是个写死的常量，
     * 所以分镜卡片看着能点、点了没反应。
     */
    // 真工程从第一镜开始；没有工程时（`/editor` 无 id 的设计稿预览）
    // 沿用设计稿选中的那一镜，否则比对截图会差一张卡的高亮
    const [currentScene, setCurrentScene] = useState(
        project ? 0 : CURRENT_SCENE_INDEX
    );
    /**
     * 可编辑状态：字幕样式 + 口播的音量语速。
     *
     * ## 为什么合成一块
     *
     * 两样都要**提到页面级**，理由一样：预览要按它们渲染/播放，而
     * `ConfigPanel` 挂着 `key={tab}`，切去别的面板再切回来会整个重挂载——
     * 存在面板自己身上的话一来一回就没了。
     *
     * 合成一块是为了**撤销**：历史栈存的是"编辑器当时的样子"。分成两份的话
     * 就要两个历史栈，而用户按 Cmd+Z 时根本不关心上一步改的是字幕还是音量。
     *
     * 初值都从**工程里存的那份**算（字幕样式来自 `styles`，音量来自配音轨的
     * `gainDb`），不是一组写死的默认值——面板一打开显示的就该是这条片子现在的样子。
     */
    const [edits, setEdits] = useState<EditorEdits>(() => ({
        subtitle: settingsFromProject(project),
        voice: voiceParamsFromProject(project),
        project: null
    }));
    const { subtitle, voice } = edits;

    /**
     * 当前这一刻的工程：动过结构就用改过的那份，否则用传进来的。
     *
     * **下面所有地方都认它**，不认 `project` 参数——漏掉一处，
     * 那一处就会显示切割之前的样子，而用户完全看不出哪里不一致。
     */
    const activeProject = edits.project ?? project;

    /**
     * 播放时钟提到页面级。
     *
     * 预览区和时间线的播放头要跟着**同一个**时钟走。各自 `usePreview` 一次的话
     * 会有两个 rAF 各跑各的，看上去就是"播放头和画面对不上"。
     */
    const preview = usePreview(activeProject ?? null);
    const { seek, timeMs } = preview;

    /**
     * **当前分镜跟着播放头走。**
     *
     * 之前它是一份独立的 state，播放推进时没人更新它——播放头走到第 3 镜，
     * 左侧文稿还高亮着第 1 镜，右侧配置区改的也是第 1 镜，
     * 而界面上完全看不出这种错位。
     *
     * 现在播放头是**唯一事实来源**：时间走到哪一镜，左中右就都是哪一镜。
     */
    /**
     * 鼠标在时间线上划到哪儿。
     *
     * 只影响**显示**，不动时钟——悬停预览是"看一眼"，移开就还原。
     * 真去改播放位置是点击才做的事。
     */
    const [scrubMs, setScrubMs] = useState<number | null>(null);
    /** 上一次切不了的原因。切成功一次就清掉 */
    const [splitError, setSplitError] = useState<string | null>(null);

    /**
     * 撤销 / 重做。
     *
     * `mergeKey` 让一次拖动只占一条历史：拖字号连发几十个值，
     * 每个都压一条的话，按一次撤销只退回一个像素。
     *
     * 时间线上的切割删除还做不了（工程格式表达不了，见 TimelineToolbar 的注释），
     * 接上之后把那些操作也走 `commit` 这条路即可，按钮不用动。
     */
    const history = useEditHistory<EditorEdits>();

    const commit = (next: EditorEdits, mergeKey: string): void => {
        // 压进历史的是**旧值**：撤销要回到的就是它
        history.push(edits, mergeKey);
        setEdits(next);
    };

    /**
     * 在播放头处切一刀。
     *
     * 切割是**纯计算**（`splitSceneAt`），这里只负责把结果压进可编辑状态。
     * 算错一处就会让工程非法，而那种错在界面上完全看不出来——
     * 所以逻辑在 video-project 里单独测，不在这个事件处理里。
     *
     * `mergeKey` 带上时刻：连切两刀是两步，要能分别撤销。
     */
    const splitAtPlayhead = (): void => {
        if (!activeProject) return;
        try {
            commit(
                {
                    ...edits,
                    project: splitSceneAt(activeProject, Math.round(timeMs)),
                    // 切出来的这份还没存过
                    savedByMain: false
                },
                `split.${Math.round(timeMs)}`
            );
            setSplitError(null);
        } catch (error) {
            // 切不了时说原因，而不是什么也不发生让人以为按钮坏了
            setSplitError(
                error instanceof Error ? error.message : String(error)
            );
        }
    };

    /**
     * 「生成口播稿」：用当前音色把整条片子重新合成一遍。
     *
     * 合成与重排在主进程里**绑在一起**做（中间那个状态是不合法的），
     * 这里拿回来的已经是重排完的整份工程，直接当成一步编辑压进历史——
     * 于是它和分割、改颜色一样可以撤销。
     *
     * **不走自动落盘**：主进程那边已经写过盘了（它要先校验再写，
     * 失败就整体不动）。这里再存一次只会重复写同一份内容。
     */
    /** 渲染导出。保存位置由主进程的对话框问，这里只管状态 */
    const exporter = useExport(projectId);

    const regenerate = useVoiceRegenerate({
        dirName: projectId,
        onDone: (next) => {
            history.push(edits, `regenerate.${next.canvas.durationMs}`);
            setEdits({ ...edits, project: next, savedByMain: true });
        }
    });

    /**
     * 「按一句要求改这一镜」。
     *
     * 和重新生成口播同一套收口方式：主进程改完返回整份新工程，
     * 这边压一条历史再换上去——**改一镜要能撤销**，模型写出来的东西
     * 不一定是用户想要的，而原来那段文案他多半没留底。
     */
    const refine = useRefineScene({
        dirName: projectId,
        onDone: (next) => {
            history.push(edits, `refine.${next.canvas.durationMs}`);
            setEdits({ ...edits, project: next, savedByMain: true });
        }
    });

    const commitSubtitle = (next: SubtitleSettings, mergeKey: string): void =>
        commit({ ...edits, subtitle: next }, mergeKey);

    const commitVoice = (next: VoiceParams, mergeKey: string): void =>
        commit({ ...edits, voice: next }, mergeKey);

    /**
     * 撤销/重做回到的那份状态**要重新落盘**：盘上现在是别的内容。
     * 所以把 `savedByMain` 清掉，让自动保存重新把它写回去。
     */
    const undo = (): void => {
        const restored = history.undo(edits);
        if (restored) setEdits({ ...restored, savedByMain: false });
    };

    const redo = (): void => {
        const restored = history.redo(edits);
        if (restored) setEdits({ ...restored, savedByMain: false });
    };

    /**
     * 键盘也要能撤销。
     *
     * 只有按钮的话，这个功能对**习惯按 Cmd+Z 的人等于不存在**——
     * 他会按一下、没反应、然后认定这个编辑器没有撤销。
     *
     * 在输入框里打字时不接管：那时候 Cmd+Z 该撤销的是文字，浏览器自己会做。
     */
    useEffect(() => {
        const onKey = (event: KeyboardEvent): void => {
            if (!(event.metaKey || event.ctrlKey) || event.key !== 'z') return;
            const target = event.target as HTMLElement | null;
            const tag = target?.tagName;
            if (
                tag === 'INPUT' ||
                tag === 'TEXTAREA' ||
                target?.isContentEditable
            ) {
                return;
            }
            event.preventDefault();
            if (event.shiftKey) redo();
            else undo();
        };
        window.addEventListener('keydown', onKey);
        return () => window.removeEventListener('keydown', onKey);
    });

    /**
     * 工程是**异步到的**：首帧 `project` 还是 undefined，`useState` 的初值
     * 那时候算的是"没有工程"那一档。工程进来之后要重算一次，
     * 否则面板上永远显示设计稿那个 24px，而片子里是 42px。
     *
     * 只在**换了工程**时重算：每次 `project` 引用变化就重置的话，
     * 用户刚选的字幕颜色会被下一次重渲染抹掉。
     */
    const projectKey = project?.project.id ?? null;
    const seededFor = useRef<string | null>(projectKey);
    useEffect(() => {
        if (seededFor.current === projectKey) return;
        seededFor.current = projectKey;
        setEdits({
            subtitle: settingsFromProject(project),
            voice: voiceParamsFromProject(project),
            project: null
        });
        // 上一个工程的历史退到这个工程上只会制造垃圾数据
        history.reset();
        // project 跟着 projectKey 走，列进来只会让换了内容的同一个工程也重置
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [projectKey]);

    /**
     * 两样东西各自落盘。
     *
     * 判「要不要存」都是**和盘上那份比一遍**：界面刚打开时算出来的值和工程里
     * 存的本来就一样，不比的话每次打开工程都会白写一次。
     */
    const { id: styleId, style: savedStyle } = baseStyleEntryOf(activeProject);
    const nextStyle = resolveSubtitleStyle(savedStyle, subtitle);

    const subtitleSave = useAutoSave(
        subtitle,
        onSubtitleStyleSave &&
            styleId !== null &&
            !sameSubtitleStyle(nextStyle, savedStyle)
            ? () => onSubtitleStyleSave({ styleId, style: nextStyle })
            : null,
        SAVE_DELAY_MS
    );

    const savedGain = voiceGainOf(activeProject);
    const nextGain = percentToGainDb(voice.volume);

    const voiceSave = useAutoSave(
        voice,
        onVoiceGainSave && savedGain !== null && nextGain !== savedGain
            ? () => onVoiceGainSave({ gainDb: nextGain })
            : null,
        SAVE_DELAY_MS
    );

    /**
     * 改过结构就把整份工程写回去。
     *
     * 这一份**带上当前的字幕样式与音量**（`applyEdits`）：不带的话，
     * 它会用底稿里那份旧样式覆盖掉刚才按字段存进去的那次修改——
     * 两条保存路径各写各的，后到的那个就会把前一个抹掉。
     */
    const structural = edits.project;
    const projectSave = useAutoSave(
        structural,
        onProjectSave && structural && !edits.savedByMain
            ? () => onProjectSave(applyEdits(structural, edits))
            : null,
        SAVE_DELAY_MS
    );

    /**
     * 顶部那行只有一个位置，两个保存共用它。
     *
     * **失败优先**：有一样没存上就该说失败，而不是被另一样的"已保存"盖过去——
     * 那会让用户以为什么都存好了。
     */
    const savers = [subtitleSave, voiceSave, projectSave];
    const saveState: SaveState | null = savers.some(
        (item) => item.state === 'failed'
    )
        ? 'failed'
        : savers.some((item) => item.state === 'saving')
          ? 'saving'
          : (savers.find((item) => item.state !== null)?.state ?? null);
    const saveError = savers.find((item) => item.error !== null)?.error ?? null;

    const playheadScene = activeProject
        ? sceneIndexAt(activeProject, timeMs)
        : null;
    useEffect(() => {
        if (playheadScene !== null) setCurrentScene(playheadScene);
    }, [playheadScene]);

    /**
     * 点某一镜 = 把播放头挪过去。
     *
     * 跳转写在这里而不是"`currentScene` 变了就 seek"的副作用里：
     * 那样写的话，播放推进跨过镜界会触发一次回跳到镜头开头，
     * 片子会在每个分镜边界卡住重播。
     */
    const selectScene = (index: number): void => {
        setCurrentScene(index);
        const target = activeProject?.scenes[index];
        if (target) seek(target.startMs);
    };

    const scene = activeProject?.scenes[currentScene];

    return (
        <div className="flex h-full w-full flex-col bg-ed-bg font-ed">
            <EditorHeader
                title={notice ?? activeProject?.project.title}
                onHome={onHome}
                // 「几分钟前更新」要从工程真算，设计稿那个写死的值对每条片子
                // 都说同一句话，而那句话是假的
                updatedAt={activeProject?.project.updatedAt}
                {...(saveState ? { saveState } : {})}
                {...(exporter.available ? { onExport: exporter.run } : {})}
                exportRatio={exporter.ratio}
                exportOutPath={exporter.outPath}
                exportError={exporter.error}
            />
            {/* 设计稿里 Body 是定高 692，代码里必须是 flex-1，否则窗口一缩就溢出 */}
            <div className="flex min-h-0 flex-1">
                <ScriptSidebar
                    project={activeProject}
                    current={currentScene}
                    onSelect={selectScene}
                />
                <PreviewPanel
                    project={activeProject}
                    projectId={projectId}
                    preview={preview}
                    scrubMs={scrubMs}
                    subtitleSettings={subtitle}
                    voiceParams={voice}
                />
                <ConfigPanel
                    tab={tab}
                    project={activeProject}
                    sceneIndex={currentScene}
                    subtitle={subtitle}
                    onSubtitleChange={commitSubtitle}
                    voice={voice}
                    onVoiceChange={commitVoice}
                    regenerate={regenerate}
                    subtitleSaveError={saveError}
                    refine={refine}
                    {...(scene && (onRequest || refine.available)
                        ? {
                              /**
                               * 同一个输入框，两种去处。
                               *
                               * **胶囊还在**（针对某一镜）→ 真把那一镜重做一遍。
                               * **胶囊叉掉了**（针对整条片子）→ 仍然只是记下来，
                               * 因为"对整条片子重做"还没有这个能力；偷偷仍然挂在
                               * 当前这一镜上更糟，那是改了他没要求改的地方。
                               *
                               * **真改这条路不依赖 `onRequest`**：那是路由注入的
                               * 「记一笔」回调，接没接上是另一回事。挂在它下面的话，
                               * 没有它的场合连改都改不了——而那两件事毫无关系。
                               */
                              onRequest: async (
                                  text: string,
                                  attachScene: boolean
                              ) => {
                                  if (attachScene && refine.available) {
                                      // 语速跟着整条片子走：不传的话这一镜会按
                                      // 1.0x 合成，而左右两镜可能是按别的速度
                                      // 重新生成过的，改完会忽然变慢
                                      await refine.run(
                                          scene.id,
                                          text,
                                          speedToRate(voice.speed)
                                      );
                                      return;
                                  }

                                  await onRequest?.({
                                      sceneId: attachScene ? scene.id : null,
                                      text
                                  });
                              }
                          }
                        : {})}
                />
                <IconRail active={tab} onChange={setTab} />
            </div>
            <Timeline
                project={activeProject}
                timeMs={preview.timeMs}
                playing={preview.playing}
                hoverMs={scrubMs}
                onSeek={seek}
                onHover={setScrubMs}
                canUndo={history.canUndo}
                canRedo={history.canRedo}
                onUndo={undo}
                onRedo={redo}
                onSplit={splitAtPlayhead}
                splitBlocked={
                    splitBlockedReason(activeProject, Math.round(timeMs)) ??
                    splitError
                }
            />
        </div>
    );
}
