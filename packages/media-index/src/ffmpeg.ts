import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

/**
 * ffmpeg / ffprobe 的可执行文件位置。
 *
 * 默认走 PATH。打包后的桌面端要改成随包分发的绝对路径，所以**必须可配置**——
 * 写死 'ffmpeg' 到了 B10 就得回头改所有调用点。
 */
export interface FfmpegBinaries {
    ffmpeg: string;
    ffprobe: string;
}

export const DEFAULT_BINARIES: FfmpegBinaries = {
    ffmpeg: 'ffmpeg',
    ffprobe: 'ffprobe'
};

export interface RunOptions {
    /** 单次调用上限。坏文件能让 ffmpeg 卡到天荒地老，必须有超时 */
    timeoutMs?: number;
    signal?: AbortSignal;
}

const DEFAULT_TIMEOUT_MS = 120_000;
/** ffprobe 对长片的 JSON 能到几百 KB，execFile 默认 1MB 不够稳妥 */
const MAX_BUFFER = 32 * 1024 * 1024;

/**
 * 外部进程失败。
 *
 * 把 stderr 原样带上：ffmpeg 的真正错因永远在 stderr 里，
 * 丢掉它就只剩一个 "exit code 1"，没法查。
 */
export class FfmpegError extends Error {
    readonly bin: string;
    readonly args: readonly string[];
    readonly exitCode: number | null;
    readonly stderr: string;

    constructor(
        bin: string,
        args: readonly string[],
        exitCode: number | null,
        stderr: string
    ) {
        super(
            `${bin} 退出码 ${exitCode ?? 'null'}：${stderr.trim().slice(0, 500)}`
        );
        this.name = 'FfmpegError';
        this.bin = bin;
        this.args = args;
        this.exitCode = exitCode;
        this.stderr = stderr;
    }
}

/** ffmpeg / ffprobe 根本不存在时抛这个，区别于"跑了但失败了" */
export class FfmpegNotFoundError extends Error {
    readonly bin: string;

    constructor(bin: string) {
        super(
            `找不到可执行文件 ${bin}。请安装 ffmpeg，或在 binaries 选项里给出绝对路径。`
        );
        this.name = 'FfmpegNotFoundError';
        this.bin = bin;
    }
}

interface ExecFailure {
    code?: number | string | null;
    stdout?: string | Buffer;
    stderr?: string | Buffer;
    killed?: boolean;
}

/**
 * 跑一个外部命令，拿到 stdout/stderr。非零退出码一律抛 FfmpegError。
 *
 * 走 `execFile` 而**不是 `exec`**：后者会先起一个 shell 再由它解析命令行，
 * 于是素材路径里的 `;`、`$(...)`、反引号都会被当成 shell 语法执行。
 * 素材路径是用户给的，等于把任意命令执行的口子开在了扫描上。
 * `execFile` 直接 spawn，参数是数组，不经过任何解析。
 */
export async function runBinary(
    bin: string,
    args: readonly string[],
    options: RunOptions = {}
): Promise<{ stdout: string; stderr: string }> {
    try {
        return await execFileAsync(bin, [...args], {
            ...execOptionsOf(options),
            encoding: 'utf8'
        });
    } catch (error) {
        throw toFfmpegError(bin, args, error);
    }
}

/**
 * 同上，但 stdout 按**二进制**拿回来。
 *
 * 抽帧时要顺手取一帧的平均色：把画面缩到 1×1 再以 rawvideo 写到 stdout，
 * 拿回来的是 3 个字节的 RGB。按 utf8 解码会把 0x80 以上的字节替换成 U+FFFD，
 * 颜色就全错了——所以这条路必须有自己的入口。
 */
export async function runBinaryRaw(
    bin: string,
    args: readonly string[],
    options: RunOptions = {}
): Promise<{ stdout: Buffer; stderr: string }> {
    try {
        const { stdout, stderr } = await execFileAsync(bin, [...args], {
            ...execOptionsOf(options),
            encoding: 'buffer'
        });
        return { stdout, stderr: stderr.toString('utf8') };
    } catch (error) {
        throw toFfmpegError(bin, args, error);
    }
}

function execOptionsOf(
    options: RunOptions
): { timeout: number; maxBuffer: number } & { signal?: AbortSignal } {
    return {
        // 坏文件能把解码器卡到天荒地老，每一次调用都必须有超时
        timeout: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
        // 长片的 ffprobe JSON 能到几百 KB，execFile 默认的 1MB 会把输出截断，
        // 截断后的 JSON 解析失败，看起来就像"这个文件探测不了"
        maxBuffer: MAX_BUFFER,
        // 传 undefined 给 execFile 是合法的；exactOptionalPropertyTypes 下要显式写
        ...(options.signal ? { signal: options.signal } : {})
    };
}

function toFfmpegError(
    bin: string,
    args: readonly string[],
    error: unknown
): Error {
    const failure = error as ExecFailure;
    if (failure.code === 'ENOENT') return new FfmpegNotFoundError(bin);
    return new FfmpegError(
        bin,
        args,
        typeof failure.code === 'number' ? failure.code : null,
        stderrOf(failure) ?? String(error)
    );
}

/** 失败对象上的 stderr 可能是 Buffer（raw 模式），也可能是字符串 */
function stderrOf(failure: ExecFailure): string | null {
    const { stderr } = failure;
    if (typeof stderr === 'string') return stderr;
    if (Buffer.isBuffer(stderr)) return stderr.toString('utf8');
    return null;
}

/** 探测两个可执行文件是否真的可用。管线启动前先跑一次，别等到第 500 个文件才发现 */
export async function assertBinariesAvailable(
    binaries: FfmpegBinaries = DEFAULT_BINARIES
): Promise<void> {
    await Promise.all([
        runBinary(binaries.ffprobe, ['-version'], { timeoutMs: 10_000 }),
        runBinary(binaries.ffmpeg, ['-version'], { timeoutMs: 10_000 })
    ]);
}
