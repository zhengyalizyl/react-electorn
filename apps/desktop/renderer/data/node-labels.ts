/**
 * 节点名 → 界面上说人话的说法。
 *
 * 单独一个文件是为了**断开循环引用**：聊天记录（run-messages）要用它，
 * 而 run-messages 又被 use-agent-run 引。放在 use-agent-run 里两边互引，
 * ESM 这次侥幸能跑，但加一个模块级初始化就会炸。
 */

/** 节点名 → 界面上说人话的进度描述 */
const NODE_LABELS: Record<string, string> = {
    CollectInput: '读取输入',
    AssetScan: '加载视频',
    CreativeBrief: '分析文稿',
    PlanProposal: '制定制作方案',
    RequirementDoc: '生成成片需求文档',
    RequirementApproval: '等你确认需求',
    ScenePlanner: '拆分镜、写文案',
    SceneApproval: '等你确认分镜',
    AssetMatcher: '匹配素材',
    MatchApproval: '等你确认素材',
    Tts: '合成配音',
    DurationAlign: '对齐时间轴',
    TimelineAssemble: '装配时间线',
    Validation: '校验工程',
    AbandonUnfixable: '跳过配不上的分镜',
    ProjectSave: '保存工程'
};

export function labelOfNode(node: string): string {
    return NODE_LABELS[node] ?? node;
}

/**
 * 这个节点名认识吗。
 *
 * 不认识的节点**不该把内部名甩到界面上**——用户看到「AssetUnderstand：…」
 * 只会一头雾水，那是图内部的叫法。调用方据此决定要不要带前缀。
 */
export function isKnownNode(node: string): boolean {
    return node in NODE_LABELS;
}
