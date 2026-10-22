import { z } from 'zod';

import type {
    SceneVoiceUpdate,
    SubtitleClip,
    VideoProject
} from '@magicut-react-demo/video-project';

import { hashScript } from './graph/nodes';
import type { SubtitleLayoutOptions } from './subtitle';
import { layoutSubtitles } from './subtitle';

/**
 * 按一句要求改一镜。
 *
 * 编辑器「快捷调整」那个输入框原来只把要求记进 `ai.requests` 就完了——
 * 它从不声称改过片子（那一点是诚实的），但用户写了一句话、看到「已记下 1 条」，
 * 然后什么也没发生。这一层就是让那句话真的生效。
 *
 * ## 为什么是「改文案 → 重念 → 整条重排」
 *
 * 时间轴由配音驱动：分镜长度 == 该镜配音时长。文案一变，这一镜的长度就变，
 * **后面每一镜的起止都要跟着挪**。所以不存在"只改这一镜"这种省事做法——
 * 只换文案不重排的工程存得下去、界面照画、播放照播，只有导出那天才会炸。
 *
 * 但 **TTS 只跑这一镜**：别的镜一个字都没变，重念一遍纯属白花钱。
 *
 * ## 这一层只做纯粹的工程改写
 *
 * 调模型、调 TTS、读写磁盘都在调用方（`apps/desktop/client/refine-scene.ts`）。
 * 这里是纯函数，因为重排牵动四条轨道和九条不变量——塞进"顺手改一下"的流程里，
 * 验证它就只剩下在界面上播一遍看看对不对。
 */

/**
 * 模型要交回来的东西。
 *
 * **只要新文案**，不让它顺手改画面意图：用户提的是一句关于口播的要求，
 * 模型借机把取材意图也换掉的话，这一镜的画面会莫名其妙地变——
 * 而他完全不知道是哪一下导致的。画面要改是另一件事。
 */
export const SceneRefineSchema = z.object({
    script: z.string().min(1)
});

export type SceneRefine = z.infer<typeof SceneRefineSchema>;

export interface SceneRefinePromptInput {
    /** 这一镜现在的文案 */
    script: string;
    /** 用户写的那句要求 */
    instruction: string;
    /** 第几镜 / 一共几镜。给模型一点位置感，别把开场写成结尾 */
    index: number;
    total: number;
    /** 前后两镜的文案。**只给相邻的**：整条片子塞进去既贵又没必要 */
    before: string;
    after: string;
    /** 这一镜现在多长。模型据此掌握篇幅，不然一句要求能换来三倍长的稿子 */
    spanMs: number;
}

/**
 * 造改写这一镜的提示词。
 *
 * **篇幅必须给约束**。不说的话，「讲得再详细一点」会换来一段三倍长的文案，
 * 而这一镜的画面素材只有原来那么长——重排之后它会定格好几秒。
 * 用户要的是"详细一点"，不是"这一镜变成一个静止画面"。
 */
export function buildSceneRefinePrompt(input: SceneRefinePromptInput): {
    system: string;
    user: string;
} {
    const seconds = (input.spanMs / 1000).toFixed(1);

    return {
        system: [
            '你在修改一条短视频里某一镜的口播文案。',
            '只输出改好之后的这一镜文案本身，不要解释，不要加序号或引号。',
            '保持和上下镜的衔接自然，不要重复相邻镜已经说过的话。',
            `篇幅控制在原来的 0.7 到 1.3 倍之间——这一镜的画面只有约 ${seconds} 秒，` +
                '写太长会让画面定格，写太短会留白。'
        ].join('\n'),
        user: [
            `这是第 ${input.index} / ${input.total} 镜。`,
            input.before === '' ? '（这是第一镜）' : `上一镜：${input.before}`,
            input.after === '' ? '（这是最后一镜）' : `下一镜：${input.after}`,
            '',
            `当前文案：${input.script}`,
            '',
            `修改要求：${input.instruction}`
        ].join('\n')
    };
}

/**
 * 创作中途改分镜文案：模型要交回来的东西。
 *
 * **条数必须和原来一样**。让模型顺手增删分镜的话，后面那两步
 * （配素材、合成）都是按这个条数排的，少一条多一条都要整条重来——
 * 而用户提的只是"第二段说得简短点"这种要求。
 */
export const ScenesReviseSchema = z.object({
    scripts: z.array(z.string().min(1))
});

export type ScenesRevise = z.infer<typeof ScenesReviseSchema>;

export interface ScenesRevisePromptInput {
    /** 当前这几镜的文案，顺序就是播放顺序 */
    scripts: readonly string[];
    /** 用户写的那句要求 */
    instruction: string;
}

/**
 * 造"按一句要求改这一版分镜"的提示词。
 *
 * 用在**分镜确认**那个中断点上：图在那里停着等人点头，这时候改是最便宜的——
 * 再往后每一步都要花钱（配素材要调模型，合成要按量计费）。
 *
 * ## 为什么要求逐条交回，而不是只交改过的那几条
 *
 * 只交改动的话，就要再约定一套"第几条改成什么"的格式，而模型在那种格式上
 * 最容易错位——改到隔壁那一镜，用户还以为是自己没说清楚。
 * 全量交回，条数对不上当场就能拦住。
 */
export function buildScenesRevisePrompt(input: ScenesRevisePromptInput): {
    system: string;
    user: string;
} {
    return {
        system: [
            '你在修改一条短视频的分镜文案。',
            `一共 ${input.scripts.length} 段，**必须原样交回 ${input.scripts.length} 段**，顺序不变。`,
            '用户的要求可能只针对其中几段：**没被提到的段落原样抄回来，一个字都不要改**。',
            '只输出文案本身，不要解释，不要加序号。'
        ].join('\n'),
        user: [
            '当前分镜：',
            ...input.scripts.map((script, i) => `${i + 1}. ${script}`),
            '',
            `修改要求：${input.instruction}`
        ].join('\n')
    };
}

/** 工程里没有这一镜时抛它，调用方据此给用户一句能看懂的话 */
export class SceneNotFoundError extends Error {
    constructor(sceneId: string) {
        super(`工程里没有 ${sceneId} 这一镜`);
        this.name = 'SceneNotFoundError';
    }
}

/**
 * 把新文案写进这一镜。
 *
 * **三处一起改**：分镜的 `script`、它的 `scriptHash`、以及那一段配音的 `text`。
 * 只改 `script` 的话工程立刻就非法了——「各段配音的字拼起来必须等于分镜文稿」
 * 是 validate 盯着的不变量，而那种工程写下去之后下次打开才会报错。
 *
 * 这一步**不碰时长**：新文案多长要等 TTS 念完才知道，由 `relayout` 收口。
 */
export function applySceneScript(
    project: VideoProject,
    sceneId: string,
    script: string
): VideoProject {
    const scene = project.scenes.find((item) => item.id === sceneId);

    if (scene === undefined) {
        throw new SceneNotFoundError(sceneId);
    }

    const next = script.trim();

    if (next === '') {
        // 空文案会把这一镜变成纯画面，那是删内容不是改内容。
        // 用户要的是「改一改」，模型交了白卷不该当成他的意思执行
        throw new Error('改写结果是空的，这一镜保持原样');
    }

    /**
     * 配音分成多段时拒绝。
     *
     * 多段意味着这一镜的文案被切过（停顿、换气、分割留下的），而重新合成
     * 给回来的是**一整段**——硬塞进去就要决定那几段各占多久，任何分法都是编的。
     * 这和 `relayoutFromVoiceDurations` 的那条限制是同一个道理，
     * 但要**在调模型之前**就说出来：那一步是花钱的。
     */
    if (scene.refs.voice.length !== 1) {
        throw new Error(
            `这一镜有 ${scene.refs.voice.length} 段配音，改文案只支持单段的`
        );
    }

    return {
        ...project,
        scenes: project.scenes.map((item) =>
            item.id === sceneId
                ? { ...item, script: next, scriptHash: hashScript(next) }
                : item
        ),
        tracks: project.tracks.map((track) =>
            track.kind === 'voice'
                ? {
                      ...track,
                      clips: track.clips.map((clip) =>
                          clip.sceneId === sceneId
                              ? { ...clip, text: next }
                              : clip
                      )
                  }
                : track
        )
    };
}

/**
 * 别的镜原样不动的那份重排输入。
 *
 * `relayoutFromVoiceDurations` 要求**每一镜都给时长**，缺一条就抛。
 * 没改的那些照抄现有时长（ratio 算出来是 1，什么都不会动），
 * 只有改过的那一镜给新的。
 */
export function sceneVoiceUpdates(
    project: VideoProject,
    changed: SceneVoiceUpdate
): SceneVoiceUpdate[] {
    return project.scenes.map((scene) =>
        scene.id === changed.sceneId
            ? changed
            : { sceneId: scene.id, durationMs: scene.durationMs }
    );
}

/**
 * 重排之后，按新文案与新时长重铺这一镜的字幕。
 *
 * **必须在 relayout 之后做**：铺字幕要用这一镜最终的起点与长度，
 * 而那两个值是重排算出来的。
 *
 * 也**必须重铺而不是沿用**：relayout 只会把旧字幕按比例缩放一下——
 * 那样成片里这一镜念的是新文案、字幕显示的还是旧句子。
 * 那种错不会报任何警，只会在成片里扎眼。
 */
export function relayoutSceneSubtitles(
    project: VideoProject,
    sceneId: string,
    options?: SubtitleLayoutOptions
): VideoProject {
    const scene = project.scenes.find((item) => item.id === sceneId);

    if (scene === undefined) {
        throw new SceneNotFoundError(sceneId);
    }

    const segments = layoutSubtitles({
        script: scene.script,
        startMs: scene.startMs,
        durationMs: scene.durationMs,
        ...(options ? { options } : {})
    });

    const track = project.tracks.find((item) => item.kind === 'subtitle');
    // 样式沿用这一镜原来那条：改文案不该顺手把字幕样式也换了
    const styleRef =
        track?.kind === 'subtitle'
            ? (track.clips.find((clip) => clip.sceneId === sceneId)?.styleRef ??
              'subtitle_default')
            : 'subtitle_default';

    /**
     * 新字幕的 id 用**分镜 id + 序号**，不接着旧的往下编。
     *
     * 接着编的话，同一镜反复改几次就会在工程里留下一串再也不会被引用的
     * 旧 id——而 `refs.subtitle` 指向谁、谁是孤儿，就得靠翻时间轴才看得出来。
     */
    const clips: SubtitleClip[] = segments.map((segment, i) => ({
        kind: 'subtitle',
        id: `clip_s_${sceneId}_${String(i + 1).padStart(2, '0')}`,
        sceneId,
        startMs: segment.startMs,
        durationMs: segment.durationMs,
        text: segment.text,
        styleRef
    })) as SubtitleClip[];

    return {
        ...project,
        scenes: project.scenes.map((item) =>
            item.id === sceneId
                ? {
                      ...item,
                      refs: {
                          ...item.refs,
                          subtitle: clips.map(
                              (clip) => clip.id
                          ) as typeof item.refs.subtitle
                      }
                  }
                : item
        ),
        tracks: project.tracks.map((track) =>
            track.kind === 'subtitle'
                ? {
                      ...track,
                      clips: [
                          // 这一镜的旧字幕整批换掉，别的镜原样留着
                          ...track.clips.filter(
                              (clip) => clip.sceneId !== sceneId
                          ),
                          ...clips
                          // 时间轴上的 clip 按起点有序，插回去要重新排
                      ].sort((a, b) => a.startMs - b.startMs)
                  }
                : track
        )
    };
}
