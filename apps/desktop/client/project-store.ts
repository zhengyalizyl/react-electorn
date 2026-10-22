import { opendir, rm } from 'node:fs/promises';
import path from 'node:path';

import type {
    SubtitleStyle,
    VideoProject
} from '@magicut-react-demo/video-project';
import { validateProject } from '@magicut-react-demo/video-project';
import {
    loadProject,
    saveProject
} from '@magicut-react-demo/video-project/node';

import type { ProjectSummary } from './agent-ipc';

/**
 * 工程仓库：扫目录、读 `project.json`、给列表页出摘要。
 *
 * ## 为什么直接扫目录而不是查 SQLite
 *
 * plan.md §9.1 的铁律：**`project.json` 是工程的唯一真源，SQLite 里关于工程的
 * 一切都是可随时重建的缓存。** 直接扫是最不容易出错的实现——不会有双写不一致，
 * 也不会出现"库里有但盘上没有"的幽灵工程。
 *
 * 十几个工程的量级，扫一遍是毫秒级。等真的慢了再加缓存，
 * 到时候**不一致时仍以 JSON 为准**。
 */

/** 工程目录的布局：`<root>/<dirName>/project.json` */
export const PROJECT_FILE = 'project.json';

function toSummary(dirName: string, project: VideoProject): ProjectSummary {
    return {
        id: project.project.id,
        title: project.project.title,
        createdAt: project.project.createdAt,
        updatedAt: project.project.updatedAt,
        durationMs: project.canvas.durationMs,
        sceneCount: project.scenes.length,
        dirName
    };
}

/**
 * 列出所有工程，最近更新的在前。
 *
 * **单个工程读失败不影响其余**：一个手改坏了的 JSON 不该让整个项目页空掉。
 * 坏的那个直接跳过——列表页不是排错的地方，用户看到的应该是"少了一个"，
 * 而不是"全没了"。
 */
export async function listProjects(root: string): Promise<ProjectSummary[]> {
    let entries;
    try {
        entries = await opendir(root);
    } catch {
        // 目录还不存在 = 一个工程都没创建过，不是错误
        return [];
    }

    const summaries: ProjectSummary[] = [];
    for await (const entry of entries) {
        if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
        try {
            const { project } = await loadProject(
                path.join(root, entry.name, PROJECT_FILE)
            );
            summaries.push(toSummary(entry.name, project));
        } catch {
            continue;
        }
    }

    // 最近更新的在前；时间相同按目录名，保证顺序稳定可断言
    summaries.sort((a, b) =>
        a.updatedAt === b.updatedAt
            ? a.dirName.localeCompare(b.dirName)
            : b.updatedAt.localeCompare(a.updatedAt)
    );
    return summaries;
}

/** 目录名里不许出现路径分隔符或 `..`——否则读写会跑到工程根之外 */
function assertSafeDirName(dirName: string): void {
    if (
        dirName.length === 0 ||
        dirName.includes('/') ||
        dirName.includes('\\') ||
        dirName === '.' ||
        dirName === '..'
    ) {
        throw new Error(`非法的工程目录名：${dirName}`);
    }
}

export async function readProject(
    root: string,
    dirName: string
): Promise<VideoProject> {
    assertSafeDirName(dirName);
    const { project } = await loadProject(
        path.join(root, dirName, PROJECT_FILE)
    );
    return project;
}

/**
 * 把用户提的一条修改要求写进工程。
 *
 * **落盘而不是只留在输入框里**：说过的话关掉窗口就没了，等于没说。
 *
 * ⚠️ 记下**不等于已经改了片子**。
 *
 * "对着某一镜重做"的能力现在有了（`refine-scene.ts`），所以这条路是**退路**：
 * 要求没挂在具体某一镜上（用户把那枚胶囊叉掉了），或者改这条路用不了时，
 * 才落到这里。界面上据此说"已记下"而不是"已修改"——
 * 两者对用户的含义差得很远。
 *
 * 读—改—写整体做完再落盘（`saveProject` 是原子写）：
 * 半截的 `project.json` 会让整个工程打不开。
 */
export async function appendRequest(
    root: string,
    dirName: string,
    request: { sceneId: string | null; text: string }
): Promise<VideoProject> {
    assertSafeDirName(dirName);
    const file = path.join(root, dirName, PROJECT_FILE);
    const { project } = await loadProject(file);

    const next: VideoProject = {
        ...project,
        ai: {
            ...project.ai,
            requests: [
                ...project.ai.requests,
                {
                    sceneId:
                        request.sceneId as VideoProject['ai']['requests'][number]['sceneId'],
                    text: request.text,
                    createdAt: new Date().toISOString()
                }
            ]
        }
    };

    await saveProject(file, next);
    return next;
}

/**
 * 改一条字幕样式。
 *
 * **落盘而不是只留在界面上**：关掉工程再打开就变回去的话，用户会以为刚才
 * 那几下白点了——而且他**没有办法知道**到底是没保存，还是保存了没生效。
 *
 * ## 为什么要先确认 styleId 存在
 *
 * 样式 id 是渲染层传过来的，**一律当不可信输入**。照单全收的话，工程里会多出
 * 一条没有任何字幕片段引用的孤儿样式——文件变大、谁也不知道它是干什么的，
 * 而用户看到的仍然是"改了没反应"（因为片段引用的还是原来那条）。
 *
 * 读—改—写整体做完再落盘（`saveProject` 是原子写，且写前过一遍 schema）：
 * 半截的 `project.json` 会让整个工程打不开。
 */
export async function saveSubtitleStyle(
    root: string,
    dirName: string,
    styleId: string,
    style: SubtitleStyle
): Promise<VideoProject> {
    assertSafeDirName(dirName);
    const file = path.join(root, dirName, PROJECT_FILE);
    const { project } = await loadProject(file);

    if (!Object.hasOwn(project.styles, styleId)) {
        throw new Error(`工程里没有这条字幕样式：${styleId}`);
    }

    const next: VideoProject = {
        ...project,
        styles: { ...project.styles, [styleId]: style }
    };

    await saveProject(file, next);
    return next;
}

/**
 * 改配音轨的音量。
 *
 * **整条轨一起改**，不是只改某一段：面板上那条滑杆说的是"这条片子的口播多响"，
 * 逐段不同的音量在界面上根本表达不出来，只改第一段会让后面几镜忽然变响。
 *
 * 范围卡在 [-60, 0]：正增益会削波（爆音），而 -60dB 已经是人耳听不见的千分之一。
 * 渲染层传来的值**一律当不可信输入**——越界不是夹一下了事，而是直接拒：
 * 悄悄改成别的值，用户看到的就是"拖到那儿但没生效"。
 */
export async function saveVoiceGain(
    root: string,
    dirName: string,
    gainDb: number
): Promise<VideoProject> {
    assertSafeDirName(dirName);
    if (!Number.isFinite(gainDb) || gainDb > 0 || gainDb < -60) {
        throw new Error(`音量超出范围（应在 -60 到 0 dB 之间）：${gainDb}`);
    }

    const file = path.join(root, dirName, PROJECT_FILE);
    const { project } = await loadProject(file);

    const next: VideoProject = {
        ...project,
        tracks: project.tracks.map((track) =>
            track.kind === 'voice'
                ? {
                      ...track,
                      clips: track.clips.map((clip) => ({ ...clip, gainDb }))
                  }
                : track
        )
    };

    await saveProject(file, next);
    return next;
}

/**
 * 整份工程写回去。
 *
 * 分割、删镜这类**改结构**的操作按字段存不下来——它们同时动四条轨道、
 * 所有分镜的起点与序号、还有画布总时长。
 *
 * ## 为什么要再校验一遍语义
 *
 * `saveProject` 写前只过 schema（结构对不对），**不查那九条不变量**
 * （分镜首尾是否相接、字幕有没有越界、源内区间和时长对不对得上…）。
 * 一份结构合法但语义错乱的工程写下去之后，界面照画、播放照播，
 * 只有导出那天才会炸——那时候已经没人记得是哪一步写坏的。
 *
 * 所以这里挡一道：**语义不合法就不许落盘**，并把问题原样说出来。
 */
export async function saveWholeProject(
    root: string,
    dirName: string,
    project: VideoProject
): Promise<VideoProject> {
    assertSafeDirName(dirName);

    const issues = validateProject(project);
    if (issues.length > 0) {
        throw new Error(
            `这份工程不合法，拒绝写入：${issues
                .map((issue) => issue.message)
                .join('；')}`
        );
    }

    const file = path.join(root, dirName, PROJECT_FILE);
    await saveProject(file, project);
    return project;
}

/**
 * 删除一个工程目录。
 *
 * 目录名先过一遍校验：渲染层传过来的东西**一律当不可信输入**，
 * 一个 `../../..` 就能把删除操作带到工程根之外。
 */
export async function removeProject(
    root: string,
    dirName: string
): Promise<void> {
    assertSafeDirName(dirName);
    const target = path.join(root, dirName);
    // 再兜一层：解析后的路径必须仍在工程根里面
    const resolved = path.resolve(target);
    if (
        resolved !== path.resolve(root) &&
        !resolved.startsWith(path.resolve(root) + path.sep)
    ) {
        throw new Error(`工程目录越界：${dirName}`);
    }
    await rm(target, { recursive: true, force: true });
}
