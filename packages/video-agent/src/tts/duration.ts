import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import { TtsProviderError } from './types';

const run = promisify(execFile);

/**
 * 量配音时长。
 *
 * **这是实测值**，不是估算，也不是接口返回的元数据
 * （plan.md §10.1：时间线的正确性不能依赖第三方元数据）。
 * 整条时间线都由它反推（§3.1），错一毫秒就全错。
 *
 * 两个 provider 共用这一份：火山出 mp3、本地 IndexTTS2 出 wav，
 * 压缩格式的字节数与时长没有线性关系，谁都不能按采样数自己算。
 * 各写各的话，迟早有一边被换成"按字数估"，而那种错不会报警——
 * 只会表现成成片里画面与声音慢慢错开。
 */
export async function measureDurationMs(
    file: string,
    scriptHash: string,
    ffprobePath = 'ffprobe'
): Promise<number> {
    try {
        const { stdout } = await run(ffprobePath, [
            '-v',
            'error',
            '-show_entries',
            'format=duration',
            '-of',
            'default=nw=1:nk=1',
            file
        ]);
        const seconds = Number(stdout.trim());
        if (!Number.isFinite(seconds) || seconds <= 0) {
            throw new Error(`ffprobe 给出的时长不可用：${stdout.trim()}`);
        }
        return Math.round(seconds * 1000);
    } catch (error) {
        throw new TtsProviderError(
            scriptHash,
            '量不出配音时长（ffprobe 失败）',
            error
        );
    }
}
