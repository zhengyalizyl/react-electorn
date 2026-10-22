import { z } from 'zod';

/**
 * 四个**窄** schema —— 给 LLM 看的输出契约。
 *
 * ## 为什么不能复用 videoProjectSchema
 *
 * 这是 plan.md §3.2「确定性的活不交给 LLM」那条边界在 schema 层的表达，
 * 写在类型里比写在注释里可靠：
 *
 * - **id 不给 LLM 编。** branded id 的分配是确定性工作，由 assembler 统一铸造
 * - **`scriptHash` / `startMs` / `durationMs` 是算出来的，不是写出来的。**
 *   `durationMs` 尤其要命——它由配音真实时长反推（§3.1）。
 *   把这些字段放进 LLM 能看见的 schema，等于邀请它填，
 *   然后你得决定信不信，而答案永远是不信
 *
 * ## 字段描述是给模型看的
 *
 * `.describe()` 的内容会被编进 JSON Schema 送给模型。取值范围、单位、格式约定
 * 都要写清楚——实测中模型把归一化坐标填成了 `500`（像素），
 * 就是因为 schema 没说「0~1」。
 */

// ── CreativeBrief：从提示词提炼创作方向 ──────────────────────────────────

export const creativeBriefSchema = z.object({
    /**
     * 用户给的到底是什么。
     *
     * 一句需求（「做条讲前端转 AI 的片子」）和一整篇口播文稿，**后面要走的路不同**：
     * 前者要替他写文案，后者要尊重原文只做切分。分不清就会把用户写好的稿子重写一遍。
     */
    inputKind: z
        .enum(['需求描述', '口播文稿', '含画面描述的脚本'])
        .describe('用户这次给的是哪一种输入'),
    /**
     * 文稿本身的结构。**从用户给的文字里读出来**，不是凭主题编的。
     * 一句需求时只有一条，写「用户只给了需求，文案待生成」。
     */
    scriptOutline: z
        .array(z.string())
        .min(1)
        .describe('输入文稿自身的段落结构，按出现顺序，每条一句话'),
    /** 现有素材撑不撑得起这个主题。判断依据是随提示词一起给的素材标签 */
    materialFit: z
        .string()
        .describe('结合给出的素材内容标签，说明素材与主题的匹配情况，一两句'),
    theme: z.string().describe('这条片子的核心主题，一句话'),
    audience: z.string().describe('目标观众是谁'),
    tone: z.string().describe('整体基调，例如「克制专业」「轻松口语」'),
    mood: z
        .enum(['平静', '欢快', '抒情', '治愈', '悲壮', '宏伟'])
        .describe('情绪基调。会用于选配乐，必须从给定项里选'),
    topic: z
        .string()
        .describe('题材领域，例如「财经」「人文」「社会」「时政」「日常」'),
    keyPoints: z
        .array(z.string())
        .min(1)
        .describe('片子要讲清楚的几个要点，按讲述顺序'),
    /**
     * 用户有没有说要多长。
     *
     * 从提示词里**抽取**而不是让模型自己定：用户说「30 秒」就该是 30 秒，
     * 没说就别替他决定。实跑里提示词写了「30 秒」而成片 21.4 秒——
     * 因为全流程之前没有任何一处以总时长为目标。
     */
    targetDurationSec: z
        .number()
        .positive()
        .nullable()
        .describe(
            '用户明确要求的成片总时长，单位秒。提示词里没提就填 null，不要自己估一个'
        )
});

export type CreativeBrief = z.infer<typeof creativeBriefSchema>;

// ── ProductionPlan：制作方案 ─────────────────────────────────────────────

/**
 * 制作方案。**分析之后、需求文档之前**的那一步。
 *
 * 分析回答的是「这是什么」，方案回答的是「打算怎么做」——两件事分开，
 * 是因为同一份文稿配不同的素材，做法完全不同：
 * 手上全是实拍就走混剪，只有几张图就得靠字幕和动效撑。
 *
 * 所以方案**必须结合素材**给，不能只看文稿拍脑袋。
 */
export const productionPlanSchema = z.object({
    approach: z
        .string()
        .describe('推荐的制作方案，一句话，例如「实拍素材混剪 + 全程口播」'),
    structure: z
        .array(z.string())
        .min(1)
        .describe('成片结构，按顺序，每条一句话'),
    pacing: z.string().describe('节奏安排，例如开头几秒抓人、中段怎么推进'),
    materialStrategy: z
        .string()
        .describe('素材怎么用。**要结合给出的素材内容标签说**，没有就说没有')
});

export type ProductionPlan = z.infer<typeof productionPlanSchema>;

// ── ScenePlan：分镜与文案 ────────────────────────────────────────────────

export const scenePlanItemSchema = z.object({
    goal: z.string().describe('这一镜要达成什么效果'),
    script: z
        .string()
        .min(1)
        .describe(
            [
                '配音文案原文——**这段字会被原样念出来**，所以它必须是口播稿，不是书面段落。',
                '口播稿的要求：',
                '1. 短句。一句话一个意思，念得完一口气；长句拆成几句',
                '2. 说人话。不用「综上所述」「值得注意的是」「本视频将」这类书面连接词',
                '3. 不出现任何念不出来的东西：不要标题、不要序号列表、不要括号注释、',
                '   不要「（停顿）」这类舞台提示、不要 Markdown 记号',
                '4. 数字与单位按口语写（「三成」而不是「30%」，「两万」而不是「20000」）',
                '5. 换行表示断句意图——换行会被用作字幕分段依据，一行就是屏幕上的一句',
                '写完自己默念一遍：不像人在说话，就重写。'
            ].join('\n')
        ),
    visualIntent: z
        .string()
        .describe('画面意图，用于检索素材。描述画面内容而不是抽象概念')
});

export const scenePlanSchema = z.object({
    scenes: z
        .array(scenePlanItemSchema)
        .min(1)
        .describe('按播出顺序排列的分镜。不要填时长，时长由配音合成后反推')
});

export type ScenePlan = z.infer<typeof scenePlanSchema>;
export type ScenePlanItem = z.infer<typeof scenePlanItemSchema>;

// ── AssetRerank：候选素材精排 ────────────────────────────────────────────

export const assetRerankSchema = z.object({
    chosenAssetId: z
        .string()
        .min(1)
        .describe('选中的素材 id，**必须**来自给定的候选列表，不要自己编'),
    reason: z.string().describe('为什么选它，一两句'),
    alternatives: z
        .array(
            z.object({
                assetId: z.string().min(1).describe('候选素材 id'),
                score: z
                    .number()
                    .min(0)
                    .max(1)
                    .describe('契合度，0 到 1 之间的小数'),
                rejected: z.string().describe('为什么没选它')
            })
        )
        .describe('其余候选的评分与落选原因，供用户追溯')
});

export type AssetRerank = z.infer<typeof assetRerankSchema>;

// ── AssetTag：关键帧打标 ─────────────────────────────────────────────────

export const assetTagSchema = z.object({
    description: z
        .string()
        .min(1)
        .describe('画面内容的客观描述，一到两句。写看得见的东西，不要推测'),
    tags: z
        .array(z.string())
        .min(1)
        .describe('检索用的关键词，例如场景、时间、人物、动作'),
    // 实测模型会把这里填成像素值，所以范围必须写死在描述里
    subjectCenterX: z
        .number()
        .min(0)
        .max(1)
        .describe(
            '主体中心的水平位置，**归一化小数**：0 是画面最左，1 是最右，居中是 0.5。不要填像素值'
        ),
    subjectCenterY: z
        .number()
        .min(0)
        .max(1)
        .describe(
            '主体中心的垂直位置，**归一化小数**：0 是画面最上，1 是最下，居中是 0.5。不要填像素值'
        ),
    orientation: z
        .enum(['landscape', 'portrait', 'square'])
        .describe('画面比例取向'),
    hasFaces: z.boolean().describe('画面里是否有清晰可辨的人脸')
});

export type AssetTag = z.infer<typeof assetTagSchema>;

// ── ScriptRewrite：按目标时长回压文案 ────────────────────────────────────

/**
 * 时长不达标时的改写。
 *
 * **只改文案，不改分镜结构**：增删分镜会把已经确认过的素材匹配全部推翻，
 * 而配音时长与文案字数直接相关，改文案就够了。
 */
export const scriptRewriteSchema = z.object({
    scripts: z
        .array(z.string().min(1))
        .min(1)
        .describe(
            '改写后的文案，**顺序与数量必须与给定的分镜完全一致**，一个都不能多也不能少'
        ),
    note: z.string().describe('这一轮做了什么调整，一句话')
});

export type ScriptRewrite = z.infer<typeof scriptRewriteSchema>;
