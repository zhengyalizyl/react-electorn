import type { VideoProject } from '@magicut-react-demo/video-project';

import type { VoiceParams } from '@/renderer/data/voice-fixtures';
import { defaultVoiceParams } from '@/renderer/data/voice-fixtures';

/**
 * 口播音量：**工程里那份说了算**。
 *
 * 和字幕样式同一条路子（见 subtitle-style.ts）。工程里每条配音片段都有
 * `gainDb`，面板上那条音量滑杆改的就是它——不是另存一份界面状态。
 *
 * ## 为什么音量存 dB 而滑杆是百分比
 *
 * 工程格式用 dB，因为那是音频领域的通用单位，导出那头（ffmpeg）也只认它。
 * 而滑杆给人看，百分比直观。两者之间是对数关系，所以换算要集中在这里——
 * 各处各算一遍的话，界面显示 80% 而实际写进去的是另一个值，
 * 这种错对不上账，也很难看出来。
 *
 * ## 语速为什么不在这儿
 *
 * 语速改的是**合成**，不是播放：真要让成片变速得用新语速重新合成全部配音、
 * 再按新时长重排整条时间线。那还做不了，所以语速只活在本次预览里，
 * 不往工程里写——写了就等于宣称成片也变速了。
 */

/**
 * 静音下限。
 *
 * 0% 对应的 dB 是负无穷，写进 JSON 就是 `-Infinity`，`JSON.stringify` 会把它
 * 变成 `null`，工程直接非法。-60dB 是千分之一的振幅，人耳已经听不见，
 * 拿它当"静音"既安全又可逆。
 */
export const MIN_GAIN_DB = -60;

/** 滑杆位置（0–100）→ 工程里的 `gainDb` */
export function percentToGainDb(percent: number): number {
    if (percent <= 0) return MIN_GAIN_DB;
    const ratio = Math.min(100, percent) / 100;
    return Math.max(MIN_GAIN_DB, Number((20 * Math.log10(ratio)).toFixed(2)));
}

/** `gainDb` → 滑杆位置。超出范围的值夹回去，手柄不会画到轨道外面 */
export function gainDbToPercent(gainDb: number): number {
    if (gainDb <= MIN_GAIN_DB) return 0;
    const ratio = Math.pow(10, Math.min(0, gainDb) / 20);
    return Math.round(Math.min(1, Math.max(0, ratio)) * 100);
}

/** 工程里配音轨当前的增益。拿不到就返回 null——**不猜** */
export function voiceGainOf(project: VideoProject | undefined): number | null {
    const track = project?.tracks.find((item) => item.kind === 'voice');
    const clip = track?.clips[0];
    return clip === undefined ? null : clip.gainDb;
}

/**
 * 打开一个工程时，口播面板该停在哪一档。
 *
 * 音量来自工程；语速没有可依据的来源，用设计稿那一档
 * （它只影响预览，不代表片子的任何属性）。
 */
export function voiceParamsFromProject(
    project: VideoProject | undefined
): VoiceParams {
    const gain = voiceGainOf(project);
    const base = defaultVoiceParams();
    return gain === null ? base : { ...base, volume: gainDbToPercent(gain) };
}
