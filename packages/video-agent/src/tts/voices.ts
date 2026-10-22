/**
 * 火山语音 2.0（`*_uranus_bigtts`）的中文音色目录。
 *
 * ## 目录 ≠ 写死
 *
 * plan.md §10 要求「端点/模型/音色/输出格式一处都不写死」。这份目录不违反它：
 * **目录是参考数据**（给界面做选择器、给校验做白名单），
 * **选哪个仍然走配置**（`TTS_VOICE`）。
 *
 * 两者分开的实际好处：配置里填了一个不存在的音色 id 时，能在**启动阶段**报出来，
 * 而不是等到第一次合成配音才收到一个看不懂的服务端错误。
 *
 * ## 音色代次必须与模型对齐
 *
 * 所有条目都是 `_uranus_bigtts` 后缀，对应 2.0 代模型（`seed-tts-2.0`）。
 * 换模型代次时音色 id 也要整批换——混用会直接被服务端拒。
 *
 * ## 这个文件是浏览器安全的
 *
 * 创作页的配音下拉直接 `import ... from '@magicut-react-demo/video-agent/voices'`。
 * 单独开这个子路径导出，是因为包的主入口拖着 langchain、sqlite、`node:*`——
 * 渲染层引进去会直接构建失败。**本文件必须保持零 import**，加依赖前先想清楚这条。
 */

/** 官方标注的适用场景 */
export type VoiceCategory = '通用场景' | '角色扮演' | '有声阅读';

export interface VoiceSpec {
    id: string;
    name: string;
    category: VoiceCategory;
    /** 官方标注的"XX 同款"。选型时的参考，没有功能含义 */
    platforms?: readonly string[];
}

/**
 * 19 个中文音色，逐条取自火山官方列表。
 *
 * 全部支持情感变化、指令遵循、ASMR，所以没有为这三项单开字段——
 * 全表取值相同的列没有区分度。哪天出现不支持的音色再加。
 */
export const VOICE_CATALOG: readonly VoiceSpec[] = [
    {
        id: 'zh_female_gaolengyujie_uranus_bigtts',
        name: '高冷御姐 2.0',
        category: '通用场景'
    },
    {
        id: 'zh_male_aojiaobazong_uranus_bigtts',
        name: '傲娇霸总 2.0',
        category: '角色扮演'
    },
    {
        id: 'zh_male_lanyinmianbao_uranus_bigtts',
        name: '懒音绵宝 2.0',
        category: '通用场景'
    },
    {
        id: 'zh_male_fanjuanqingnian_uranus_bigtts',
        name: '反卷青年 2.0',
        category: '通用场景'
    },
    {
        id: 'zh_female_wenroushunv_uranus_bigtts',
        name: '温柔淑女 2.0',
        category: '角色扮演',
        platforms: ['番茄小说同款', '豆包同款', '剪映同款']
    },
    {
        id: 'zh_female_gufengshaoyu_uranus_bigtts',
        name: '古风少御 2.0',
        category: '通用场景'
    },
    {
        id: 'zh_male_huolixiaoge_uranus_bigtts',
        name: '活力小哥 2.0',
        category: '有声阅读'
    },
    {
        id: 'zh_male_baqiqingshu_uranus_bigtts',
        name: '霸气青叔 2.0',
        category: '有声阅读',
        platforms: ['番茄小说同款', '豆包同款', '剪映同款']
    },
    {
        id: 'zh_male_xuanyijieshuo_uranus_bigtts',
        name: '悬疑解说 2.0',
        category: '通用场景',
        platforms: ['抖音同款', '豆包同款', '剪映同款']
    },
    {
        id: 'zh_female_mengyatou_uranus_bigtts',
        name: '萌丫头/Cutey 2.0',
        category: '通用场景'
    },
    {
        id: 'zh_female_tiexinnvsheng_uranus_bigtts',
        name: '贴心女声/Candy 2.0',
        category: '通用场景'
    },
    {
        id: 'zh_female_jitangmei_uranus_bigtts',
        name: '鸡汤妹妹/Hope 2.0',
        category: '通用场景',
        platforms: ['抖音同款', '豆包同款']
    },
    {
        id: 'zh_male_cixingjieshuonan_uranus_bigtts',
        name: '磁性解说男声/Morgan 2.0',
        category: '通用场景',
        platforms: ['抖音同款', '剪映同款']
    },
    {
        id: 'zh_male_liangsangmengzai_uranus_bigtts',
        name: '亮嗓萌仔 2.0',
        category: '通用场景'
    },
    {
        id: 'zh_female_kailangjiejie_uranus_bigtts',
        name: '开朗姐姐 2.0',
        category: '通用场景'
    },
    {
        id: 'zh_male_gaolengchenwen_uranus_bigtts',
        name: '高冷沉稳 2.0',
        category: '通用场景',
        platforms: ['猫箱同款']
    },
    {
        id: 'zh_male_shenyeboke_uranus_bigtts',
        name: '深夜播客 2.0',
        category: '角色扮演'
    },
    {
        id: 'zh_male_lubanqihao_uranus_bigtts',
        name: '鲁班七号 2.0',
        category: '通用场景',
        platforms: ['抖音同款', '豆包同款', '剪映同款']
    },
    {
        id: 'zh_female_jiaochuannv_uranus_bigtts',
        name: '娇喘女声 2.0',
        category: '通用场景',
        platforms: ['抖音同款', '剪映同款']
    }
];

/**
 * 默认音色。
 *
 * 选「磁性解说男声」是因为它是官方标注里**唯一带"解说"定位又在通用场景**的男声，
 * 最贴近口播短片的用途。这只是默认值，`TTS_VOICE` 随时可以覆盖。
 */
export const DEFAULT_VOICE_ID = 'zh_male_cixingjieshuonan_uranus_bigtts';

const BY_ID = new Map(VOICE_CATALOG.map((voice) => [voice.id, voice]));

export function findVoice(id: string): VoiceSpec | undefined {
    return BY_ID.get(id);
}

/** 目录里有没有这个 id。配置校验用它，好在启动阶段就报错 */
export function isKnownVoice(id: string): boolean {
    return BY_ID.has(id);
}

/**
 * 从音色 id 认出性别。
 *
 * 官方目录没有性别字段，但 id 前缀 `zh_female_` / `zh_male_` 是它自己带的信息——
 * 比我替音色编一句"温柔知性的女声"可靠：那种描述是编的，这个是数据里就有的。
 *
 * 界面用它给每一行凑出一句说明：官方只给一部分音色标了"XX 同款"，
 * 光靠那个的话大半行是空的，列表看着像坏了。
 */
export function voiceGender(voice: VoiceSpec): '女声' | '男声' | null {
    if (voice.id.startsWith('zh_female_')) return '女声';
    if (voice.id.startsWith('zh_male_')) return '男声';
    return null;
}

/** 界面上每一行的第二行文案。**不编造**：只拼 id 与官方标注里已有的信息 */
export function voiceSubtitle(voice: VoiceSpec): string {
    const parts = [
        voiceGender(voice),
        voice.category,
        ...(voice.platforms ?? [])
    ];
    return parts.filter((part): part is string => part !== null).join(' · ');
}

export function voicesByCategory(category: VoiceCategory): VoiceSpec[] {
    return VOICE_CATALOG.filter((voice) => voice.category === category);
}
