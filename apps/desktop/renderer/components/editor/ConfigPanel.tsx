import type { ComponentType } from 'react';

import type { VideoProject } from '@magicut-react-demo/video-project';

import type { EditorTab } from '@/renderer/components/editor/IconRail';
import MusicConfig from '@/renderer/components/editor/MusicConfig';
import SubtitleConfig from '@/renderer/components/editor/SubtitleConfig';
import VisualConfig from '@/renderer/components/editor/VisualConfig';
import VoiceConfig from '@/renderer/components/editor/VoiceConfig';
import type { SubtitleSettings } from '@/renderer/data/subtitle-style';
import type { RefineSceneState } from '@/renderer/data/use-refine-scene';
import type { VoiceRegenerateState } from '@/renderer/data/use-voice-regenerate';
import type { VoiceParams } from '@/renderer/data/voice-fixtures';

/**
 * 各实现共用的入参。
 *
 * 目前只有「画面」用得上工程数据；其余三张还是设计稿的静态样子，
 * 接真数据时把参数用起来即可，不用改这里的分派。
 */
export interface ConfigImplementationProps {
    project?: VideoProject | undefined;
    /** 当前选中的分镜序号 */
    sceneIndex?: number | undefined;
    /**
     * 记一条修改要求。不传时输入框只读——**没有去处的输入不如不给**。
     *
     * `attachScene` 说的是这条要求针对当前这一镜还是整条片子：
     * 用户可以把输入框上那枚分镜胶囊叉掉。
     */
    onRequest?:
        | ((text: string, attachScene: boolean) => Promise<void> | void)
        | undefined;
    /**
     * 字幕设置。
     *
     * **由页面持有**，不在字幕面板自己身上：预览要按它渲染，而且这个组件挂着
     * `key={tab}`，切到别的面板再切回来会整个重挂载——存在自己身上的话，
     * 一来一回就丢了。
     */
    subtitle?: SubtitleSettings | undefined;
    /**
     * 不传时字幕面板只显示、改不动——**没有去处的输入不如不给**。
     *
     * `mergeKey` 是给撤销用的：相邻两次改同一样东西并成一条历史。
     * 没有它的话，拖一次字号滑杆会压几十条历史，
     * 按一次撤销只退回一个像素。
     */
    onSubtitleChange?:
        | ((next: SubtitleSettings, mergeKey: string) => void)
        | undefined;
    /**
     * 字幕样式没能写进工程时的原因。
     *
     * 存不下去这件事**必须说出口**：用户以为存住了，下次打开发现没有，
     * 而中间没有任何一处说过话——那比当场报错糟得多。
     */
    subtitleSaveError?: string | null | undefined;
    /**
     * 口播的音量与语速（都是 0–100 的滑杆位置）。
     *
     * 和字幕设置同样的道理：**预览要按它播**，所以不能存在口播面板自己身上。
     * 之前它们只是面板里的两个数字，拖得动、读数也跟着变，
     * 但播出来的声音一点变化都没有——那和死按钮是同一类问题。
     */
    voice?: VoiceParams | undefined;
    onVoiceChange?: ((next: VoiceParams, mergeKey: string) => void) | undefined;
    /**
     * 「生成口播稿」那条链路的状态与入口。
     *
     * 由页面持有：合成完要把新工程交回去（整条时间线都重排过了），
     * 而面板自己没有地方放那份工程。
     */
    regenerate?: VoiceRegenerateState | undefined;
    /**
     * 「按一句要求改这一镜」那条链路的状态。
     *
     * 和 `regenerate` 同样由页面持有：改完主进程返回整份新工程，
     * 而快捷调整那个输入框自己没有地方放它。
     */
    refine?: RefineSceneState | undefined;
}

// 每种素材类型一个实现，各自对应一张设计稿 frame
const implementations: Record<
    EditorTab,
    ComponentType<ConfigImplementationProps>
> = {
    visual: VisualConfig,
    voice: VoiceConfig,
    subtitle: SubtitleConfig,
    music: MusicConfig
};

interface ConfigPanelProps extends ConfigImplementationProps {
    tab: EditorTab;
}

/** 右侧配置区的入口：只按当前模式选实现，不掺具体配置逻辑 */
export default function ConfigPanel({ tab, ...rest }: ConfigPanelProps) {
    const Implementation = implementations[tab];

    // key 挂 tab：切换时强制重挂载，PanelFrame 的入场动画才会重放。
    // 不加 key 的话 React 会复用同类型节点，动画只在首次出现时播一次。
    return <Implementation key={tab} {...rest} />;
}
