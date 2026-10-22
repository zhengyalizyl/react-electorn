import { existsSync, mkdirSync, rmSync, statSync } from 'node:fs';
import path from 'node:path';
import sqlite3 from 'node-sqlite3-wasm';

/**
 * 语音缓存的元数据库。
 *
 * ## 光有文件为什么不够
 *
 * `cache.ts` 那层只回答"这个键的文件在不在"。但命中之后还得知道**时长**——
 * 时间轴整个由它反推（plan.md §3.1），而从文件算时长要起一个 ffprobe 进程。
 * 把时长记下来，命中就是一次 SQL 查询，**连进程都不用起**。
 *
 * 再往下，要做 LRU 与容量上限，就得知道每份多大、上次什么时候被用过——
 * 这些文件系统本身答不了（mtime 是写入时间，不是访问时间；atime 很多挂载选项下不更新）。
 *
 * ## 和索引库的关系
 *
 * **是另一个库文件**，同 `checkpoints.db` 的理由（plan.md §9）：
 * 生命周期不同。清空语音缓存只意味着"下次要重新合成"，
 * 不该牵动素材索引，更不该牵动工程。
 */

const { Database } = sqlite3;
type SqliteDatabase = InstanceType<typeof Database>;
type Row = Record<string, unknown>;

const DDL = `
create table if not exists tts_cache (
    key             text primary key,
    path            text not null,
    duration_ms     integer not null,
    size_bytes      integer not null,
    created_at      integer not null,
    last_access_at  integer not null,
    access_count    integer not null default 1
);
-- LRU 要按最久未用排序，淘汰时走这条索引
create index if not exists idx_tts_cache_lru on tts_cache(last_access_at);
`;

export interface TtsCacheEntry {
    key: string;
    path: string;
    durationMs: number;
    sizeBytes: number;
    createdAt: number;
    lastAccessAt: number;
    accessCount: number;
}

export interface TtsCachePut {
    key: string;
    path: string;
    durationMs: number;
    sizeBytes: number;
    /** 注入时间便于测试。不给就是现在 */
    lastAccessAt?: number;
}

export interface SweepOptions {
    /** 缓存总大小上限，字节。超了按最久未用删起 */
    maxTotalBytes?: number;
    /** 多久没被访问就清掉，天 */
    maxAgeDays?: number;
    /** 注入"现在"便于测试 */
    now?: number;
}

export interface SweepResult {
    /** 因为过期被清掉的条数 */
    expired: number;
    /** 因为超容量被淘汰的条数 */
    evicted: number;
    freedBytes: number;
}

/**
 * 打开前先建好父目录。
 *
 * 不建的话驱动只会给一句 `Could not open the database`，看不出是路径不存在——
 * 而桌面端**首次启动时它本来就不存在**。
 */
function ensureParentDir(file: string): void {
    if (file === ':memory:' || file === '') return;
    mkdirSync(path.dirname(path.resolve(file)), { recursive: true });
}

function asInt(value: unknown): number {
    return typeof value === 'number' ? Math.round(value) : 0;
}

function asText(value: unknown): string {
    return typeof value === 'string' ? value : '';
}

function toEntry(row: Row): TtsCacheEntry {
    return {
        key: asText(row['key']),
        path: asText(row['path']),
        durationMs: asInt(row['duration_ms']),
        sizeBytes: asInt(row['size_bytes']),
        createdAt: asInt(row['created_at']),
        lastAccessAt: asInt(row['last_access_at']),
        accessCount: asInt(row['access_count'])
    };
}

export class TtsCacheStore {
    private readonly db: SqliteDatabase;

    private constructor(db: SqliteDatabase) {
        this.db = db;
    }

    /** `:memory:` 用于测试；给路径则落盘 */
    static open(file: string): TtsCacheStore {
        ensureParentDir(file);
        const db = new Database(file);
        db.exec(DDL);
        return new TtsCacheStore(db);
    }

    close(): void {
        this.db.close();
    }

    /**
     * 查缓存。命中会记一次访问（LRU 靠它）。
     *
     * **库里说有、盘上没了，要当没命中并把那行清掉。** 用户手动清过 audio
     * 目录、换过机器、同步工具删过文件——留着那行的话每次都"命中"，
     * 然后返回一个不存在的路径，错会推到播放那一步才爆。
     *
     * 0 字节同理：上次写到一半被 kill 留下的空壳，认它的话这一镜永远静音，
     * 而且**永远自愈不了**。
     */
    get(key: string, now = Date.now()): TtsCacheEntry | null {
        const row = this.db.get('select * from tts_cache where key = ?', [
            key
        ]) as Row | null;
        if (!row) return null;

        const entry = toEntry(row);
        let usable = false;
        try {
            const info = statSync(entry.path);
            usable = info.isFile() && info.size > 0;
        } catch {
            usable = false;
        }
        if (!usable) {
            this.db.run('delete from tts_cache where key = ?', [key]);
            return null;
        }

        this.db.run(
            `update tts_cache
                set last_access_at = ?, access_count = access_count + 1
              where key = ?`,
            [Math.round(now), key]
        );
        return {
            ...entry,
            lastAccessAt: Math.round(now),
            accessCount: entry.accessCount + 1
        };
    }

    /** 登记一份新合成的音频。同 key 再登记是覆盖，不是堆两行 */
    put(entry: TtsCachePut, now = Date.now()): void {
        const at = Math.round(entry.lastAccessAt ?? now);
        this.db.run(
            `insert into tts_cache
                 (key, path, duration_ms, size_bytes, created_at, last_access_at, access_count)
             values (?, ?, ?, ?, ?, ?, 1)
             on conflict(key) do update set
                 path = excluded.path,
                 duration_ms = excluded.duration_ms,
                 size_bytes = excluded.size_bytes,
                 last_access_at = excluded.last_access_at`,
            [
                entry.key,
                entry.path,
                Math.round(entry.durationMs),
                Math.round(entry.sizeBytes),
                at,
                at
            ]
        );
    }

    stats(): { entries: number; totalBytes: number } {
        const row = this.db.get(
            'select count(*) c, coalesce(sum(size_bytes), 0) s from tts_cache'
        ) as Row | null;
        return {
            entries: asInt(row?.['c']),
            totalBytes: asInt(row?.['s'])
        };
    }

    /**
     * 清理。**先过期、再容量**——顺序是有讲究的。
     *
     * 反过来的话，会为了腾容量去淘汰一份还在用的，而那份本来就不用删：
     * 把过期的清掉之后容量可能已经够了。
     *
     * 删的是**行和文件**。只删行的话磁盘永远不会变小，等于没做清理。
     */
    sweep(options: SweepOptions = {}): SweepResult {
        const now = options.now ?? Date.now();
        const result: SweepResult = { expired: 0, evicted: 0, freedBytes: 0 };

        // ── 过期 ──
        if (options.maxAgeDays !== undefined) {
            const cutoff = now - options.maxAgeDays * 24 * 60 * 60 * 1000;
            const rows = this.db.all(
                'select * from tts_cache where last_access_at < ?',
                [Math.round(cutoff)]
            ) as Row[];
            for (const row of rows) {
                this.drop(toEntry(row));
                result.expired += 1;
                result.freedBytes += asInt(row['size_bytes']);
            }
        }

        // ── 容量 ──
        if (options.maxTotalBytes !== undefined) {
            let total = this.stats().totalBytes;
            if (total > options.maxTotalBytes) {
                // 最久未用的排在前面，删到降下来为止
                const rows = this.db.all(
                    'select * from tts_cache order by last_access_at asc'
                ) as Row[];
                for (const row of rows) {
                    if (total <= options.maxTotalBytes) break;
                    const entry = toEntry(row);
                    this.drop(entry);
                    total -= entry.sizeBytes;
                    result.evicted += 1;
                    result.freedBytes += entry.sizeBytes;
                }
            }
        }

        return result;
    }

    /** 删一行连带它的文件。文件删不掉不该让整轮清理中断 */
    private drop(entry: TtsCacheEntry): void {
        this.db.run('delete from tts_cache where key = ?', [entry.key]);
        try {
            if (existsSync(entry.path)) rmSync(entry.path);
        } catch {
            // 文件被占用、权限不足：行已经删了，下次合成会重新写一份
        }
    }
}
