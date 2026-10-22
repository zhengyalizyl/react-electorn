// 本文件的内容逐字取自 magicut-demo.pen 的 frame HzNgd（妙剪 Magicut — 创作页-输入文稿）。
// 接真实音色库前整体替换。

export const HEADLINE_PLAIN = '让文字';

export const HEADLINE_GRADIENT = '赴一场光影之约';

export const SUBHEAD = '顷刻成帧，每一种表达都自有回响';

export const SCRIPT_PLACEHOLDER = '输入/粘贴视频文稿，为你生成精彩视频';

/** 设计稿计数器写的是 0 / 10000 */
export const SCRIPT_MAX_LENGTH = 10000;

export type CreateTab = 'script' | 'audio';

export interface TabItem {
    id: CreateTab;
    label: string;
}

export const tabs = [
    { id: 'script', label: '输入文稿' },
    { id: 'audio', label: '上传口播音频' }
] as const satisfies readonly TabItem[];

// 音色不在这里：设计稿画的那四个（温婉学姐、沉稳学长……）是占位，
// 真列表是火山的 19 个 2.0 中文音色，见 `@magicut-react-demo/video-agent/voices`。
// 界面选中的 id 会原样发给主进程去合成，编出来的名字到那步只会被服务端拒。
