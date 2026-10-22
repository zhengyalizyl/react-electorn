import { randomUUID } from 'node:crypto';
import { open, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

import type { VideoProject } from './schema';
import { CURRENT_SCHEMA_VERSION, videoProjectSchema } from './schema';
import type { ValidationIssue } from './validate';
import { validateProject } from './validate';

/**
 * 工程文件的读写。
 *
 * 写入必须是原子的：直接覆写时如果进程中途挂了，磁盘上会留下半截 JSON，
 * 整个工程就报废了。做法是写临时文件 → fsync → rename，rename 在同一文件系统内
 * 是原子操作，读者要么看到旧文件要么看到新文件，不会看到中间态。
 */

export interface LoadResult {
    project: VideoProject;
    /** 语义校验结果。结构错误会直接抛异常，不走这里 */
    issues: ValidationIssue[];
    /** 是否经过了版本迁移 */
    migrated: boolean;
}

export class ProjectFormatError extends Error {
    // Error 基类本身就有 cause，用 override 显式声明覆盖，
    // 否则 noImplicitOverride 会拒绝
    override readonly cause?: unknown;

    constructor(message: string, cause?: unknown) {
        super(message);
        this.name = 'ProjectFormatError';
        this.cause = cause;
    }
}

/**
 * 版本迁移表：键是**源版本**，值把该版本的数据升到下一版。
 *
 * 工程文件会长期存在于用户磁盘上，格式一定会变。加载时逐级迁移，
 * 不允许跳版——跳版意味着中间那次结构变更没人验证过。
 */
const MIGRATIONS: Record<
    number,
    (raw: Record<string, unknown>) => Record<string, unknown>
> = {
    /**
     * 1 → 2：配音片段补上源内区间（`inMs`/`outMs`）。
     *
     * v1 的配音都是**整段播放**，所以区间就是 `0 .. durationMs`。
     * 不补的话旧工程一打开就通不过 schema——而用户磁盘上那些片子是真实存在的，
     * 不能因为我们加了个字段就打不开了。
     *
     * 已经有这两个字段就不覆盖（`...entry` 放在后面）：
     * 迁移要能重复跑而不改变结果，否则一次误判就把数据改坏了。
     */
    1: (raw) => ({
        ...raw,
        schemaVersion: 2,
        tracks: (Array.isArray(raw['tracks']) ? raw['tracks'] : []).map(
            (track: unknown) => {
                const item = track as Record<string, unknown>;
                if (item['kind'] !== 'voice') return item;

                const clips = Array.isArray(item['clips']) ? item['clips'] : [];
                return {
                    ...item,
                    clips: clips.map((clip: unknown) => {
                        const entry = clip as Record<string, unknown>;
                        const duration =
                            typeof entry['durationMs'] === 'number'
                                ? entry['durationMs']
                                : 0;
                        return { inMs: 0, outMs: duration, ...entry };
                    })
                };
            }
        )
    }),

    /**
     * 2 → 3：视频片段带上画面效果（抠图换背景、人像美颜）。
     *
     * **这一步只盖版本号。** 新字段在 schema 里全都有默认值，v2 的片段解析时
     * 会自动补上"两样都关着"——照抄一份默认值到这里，等于把同一组数字写两遍，
     * 而两边迟早会不一致。
     *
     * 那为什么还要这条迁移？因为版本号本身要往上走：升到 3 之后，旧版应用
     * 打开新工程会明确拒绝，而不是悄悄把 `effects` 剥掉再存回去
     * （理由见 schema.ts 的 `CURRENT_SCHEMA_VERSION`）。
     */
    2: (raw) => ({ ...raw, schemaVersion: 3 })
};

function migrate(raw: Record<string, unknown>): {
    data: Record<string, unknown>;
    migrated: boolean;
} {
    let data = raw;
    let version =
        typeof data.schemaVersion === 'number' ? data.schemaVersion : 0;
    let migrated = false;

    if (version < 1) {
        throw new ProjectFormatError(
            `无法识别的 schemaVersion: ${String(data.schemaVersion)}`
        );
    }

    if (version > CURRENT_SCHEMA_VERSION) {
        throw new ProjectFormatError(
            `工程版本 ${version} 高于当前支持的 ${CURRENT_SCHEMA_VERSION}，请升级应用`
        );
    }

    while (version < CURRENT_SCHEMA_VERSION) {
        const step = MIGRATIONS[version];

        if (!step) {
            throw new ProjectFormatError(
                `缺少从 v${version} 到 v${version + 1} 的迁移`
            );
        }

        data = step(data);
        version += 1;
        migrated = true;
    }

    return { data, migrated };
}

/** 解析并校验一份工程数据。结构非法抛错，语义问题以 issues 返回 */
export function parseProject(raw: unknown): LoadResult {
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
        throw new ProjectFormatError('工程文件根节点必须是对象');
    }

    const { data, migrated } = migrate(raw as Record<string, unknown>);
    const parsed = videoProjectSchema.safeParse(data);

    if (!parsed.success) {
        throw new ProjectFormatError(
            `工程结构校验失败：${parsed.error.issues
                .map((issue) => `${issue.path.join('.')} ${issue.message}`)
                .join('; ')}`,
            parsed.error
        );
    }

    return {
        project: parsed.data,
        issues: validateProject(parsed.data),
        migrated
    };
}

export async function loadProject(file: string): Promise<LoadResult> {
    const { readFile } = await import('node:fs/promises');
    const text = await readFile(file, 'utf8');

    let raw: unknown;

    try {
        raw = JSON.parse(text);
    } catch (error) {
        throw new ProjectFormatError(`工程文件不是合法 JSON：${file}`, error);
    }

    return parseProject(raw);
}

/**
 * 原子写入工程文件。
 *
 * 临时文件放在目标同目录：rename 只在同一文件系统内原子，
 * 放到系统 temp 目录再 rename 可能跨设备，退化成非原子的复制。
 */
export async function saveProject(
    file: string,
    project: VideoProject
): Promise<void> {
    const parsed = videoProjectSchema.safeParse(project);

    if (!parsed.success) {
        throw new ProjectFormatError(
            `拒绝写入结构非法的工程：${parsed.error.issues
                .map((issue) => `${issue.path.join('.')} ${issue.message}`)
                .join('; ')}`,
            parsed.error
        );
    }

    const tmp = path.join(
        path.dirname(file),
        `.${path.basename(file)}.${randomUUID()}.tmp`
    );

    try {
        await writeFile(
            tmp,
            `${JSON.stringify(parsed.data, null, 4)}\n`,
            'utf8'
        );

        // fsync 后再 rename：否则断电时 rename 可能已生效而内容还在页缓存里
        const handle = await open(tmp, 'r+');

        try {
            await handle.sync();
        } finally {
            await handle.close();
        }

        await rename(tmp, file);
    } catch (error) {
        await rm(tmp, { force: true });
        throw error;
    }
}
