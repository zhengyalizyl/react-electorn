import type { ModelProvider } from '@magicut-react-demo/video-agent';
import {
    buildScenesRevisePrompt,
    ScenesReviseSchema
} from '@magicut-react-demo/video-agent';

import { resolveModelProvider } from './agent-runner';

/**
 * 创作停在「分镜确认」时，按一句要求把这一版文案改一改。
 *
 * ## 为什么只在这个中断点上做
 *
 * 图里有三个中断点，只有分镜确认这一个的契约里带着
 * `{ action: 'modify', scripts }`——也就是说"把改过的文案交回去"这条路
 * **本来就通**，缺的只是"用一句话代替逐条手改"。
 *
 * 另外两个：需求文档只有放行一个动作（要改得回去改提示词），
 * 素材确认是在候选里挑，都不是文本能表达的。
 *
 * ## 为什么在这里改最划算
 *
 * 图停在这儿等人点头，而**再往后每一步都要花钱**：配素材要调模型，
 * 合成要按量计费。改完再放行，等于一次都没白花。
 *
 * ## 改完不直接放行
 *
 * 这一层只负责**把新文案算出来**，交回渲染层填进那几个文本框。
 * 直接替用户点头的话，模型写成什么样他根本没看见，而放行之后
 * 那几步的钱已经花出去了。
 */

export interface ReviseScenesOptions {
    /** 当前这一版文案，顺序就是播放顺序 */
    scripts: readonly string[];
    /** 用户写的那句要求 */
    instruction: string;
    env?: Record<string, string | undefined>;
    /** 用哪个模型。不传就按 `.env` 的配置建一个。注入口是为了能测 */
    model?: ModelProvider | undefined;
    /** 启动时找过的 .env 位置。缺凭证时要把它们列给用户看 */
    envSearchPaths?: readonly string[] | undefined;
}

export async function reviseScenes(
    options: ReviseScenesOptions
): Promise<string[]> {
    const instruction = options.instruction.trim();
    if (instruction === '') {
        throw new Error('没写要求，不知道要改什么');
    }

    if (options.scripts.length === 0) {
        throw new Error('现在没有可改的分镜');
    }

    // 凭证不对要在**调模型之前**报出来，而且给的是能照着做的那句话。
    // 那段顺序很容易写反，收在 `resolveModelProvider` 里了
    const model =
        options.model ??
        resolveModelProvider(
            options.env ?? process.env,
            options.envSearchPaths ?? []
        );

    const prompt = buildScenesRevisePrompt({
        scripts: options.scripts,
        instruction
    });

    const result = await model.invokeStructured({
        task: 'ScenesRevise',
        schema: ScenesReviseSchema,
        system: prompt.system,
        user: prompt.user
    });

    const scripts = result.value.scripts.map((script) => script.trim());

    /**
     * **条数对不上就整份作废。**
     *
     * 模型顺手合并或拆分了分镜的话，交回去的 `scripts` 会和图里那几镜
     * 对不上号——`modify` 那条契约是按下标配对的，错位之后用户看到的是
     * "第二镜的文案跑到第三镜去了"，而他完全不知道为什么。
     *
     * 与其猜着对齐，不如让他再说一遍。
     */
    if (scripts.length !== options.scripts.length) {
        throw new Error(
            `模型交回了 ${scripts.length} 段，和现在的 ${options.scripts.length} 段对不上，已放弃本次修改`
        );
    }

    if (scripts.some((script) => script === '')) {
        // 空文案会把那一镜变成纯画面，那是删内容不是改内容
        throw new Error('模型把其中一段写空了，已放弃本次修改');
    }

    return scripts;
}
