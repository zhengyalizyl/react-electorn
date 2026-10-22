import { createHash } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import sqlite3 from 'node-sqlite3-wasm';

import { contentKeyOf } from './scan';
import { normalizeFileName, toIndexText, toMatchExpression } from './text';
import type {
    AssetOverview,
    AssetSegment,
    Keyframe,
    MediaFileRecord,
    MediaKind,
    ProbeResult,
    ScannedFile,
    SearchFilters,
    SearchHit,
    StageState
} from './types';

const { Database } = sqlite3;
type SqliteDatabase = InstanceType<typeof Database>;
type Row = Record<string, unknown>;

/**
 * 索引库的结构版本。改表结构时 +1，并在 `migrate` 里补一段。
 *
 * 注意这个库与 `project.json` 的地位完全不同（plan.md §9.1）：
 * **索引全是派生数据，删库只意味着要重扫一遍，不会丢任何工程。**
 * 所以迁移失败时直接重建是合法退路，不必像工程文件那样死保。
 */
export const SCHEMA_VERSION = 2;

const DDL = `
create table if not exists media_files (
    id               integer primary key autoincrement,
    path             text    not null unique,
    size_bytes       integer not null,
    mtime_ms         integer not null,
    content_key      text    not null,
    kind             text    not null default 'video',
    probe_state      text    not null default 'pending',
    probe_error      text,
    duration_ms      integer,
    width            integer,
    height           integer,
    fps              real,
    video_codec      text,
    has_audio        integer,
    audio_codec      text,
    rotation_degrees integer,
    bit_rate_bps     integer,
    thumbnail_path   text,
    keyframe_state   text    not null default 'pending',
    keyframe_error   text,
    updated_at       integer not null
);
create index if not exists idx_files_probe    on media_files(probe_state);
create index if not exists idx_files_keyframe on media_files(keyframe_state);
create index if not exists idx_files_kind     on media_files(kind);

create table if not exists keyframes (
    file_id   integer not null references media_files(id) on delete cascade,
    at_ms     integer not null,
    path      text    not null,
    avg_color text,
    primary key (file_id, at_ms)
);

-- 索引库自身的状态。目前只存"上次扫描完成于何时"，用来在界面上说
-- "距上次扫描 3 天"，也便于排查"为什么这个新文件没被扫到"
create table if not exists index_meta (
    key   text primary key,
    value text not null
);

create table if not exists asset_segments (
    id           text    primary key,
    file_id      integer not null references media_files(id) on delete cascade,
    start_ms     integer not null,
    duration_ms  integer not null,
    tag_state    text    not null default 'pending',
    tag_error    text,
    description  text,
    tags         text,
    subject_x    real,
    subject_y    real,
    orientation  text,
    has_faces    integer,
    updated_at   integer not null
);
create index if not exists idx_segments_file     on asset_segments(file_id);
create index if not exists idx_segments_tag      on asset_segments(tag_state);
create index if not exists idx_segments_duration on asset_segments(duration_ms);

create virtual table if not exists asset_fts using fts5(
    segment_id unindexed,
    filename,
    description,
    tags
);
`;

function boolToInt(value: boolean | null): number | null {
    return value === null ? null : value ? 1 : 0;
}

function intToBool(value: unknown): boolean | null {
    if (value === null || value === undefined) return null;
    return Number(value) !== 0;
}

function asString(value: unknown): string | null {
    return typeof value === 'string' ? value : null;
}

function asInt(value: unknown): number | null {
    return typeof value === 'number' ? Math.round(value) : null;
}

function parseTags(value: unknown): string[] {
    if (typeof value !== 'string' || !value) return [];
    try {
        const parsed: unknown = JSON.parse(value);
        return Array.isArray(parsed)
            ? parsed.filter((t): t is string => typeof t === 'string')
            : [];
    } catch {
        return [];
    }
}

/** 片段 id 由 `路径 + 区间` 决定，同一个文件重扫得到同一个 id——续跑时不会产生孤儿行 */
export function segmentIdFor(
    filePath: string,
    startMs: number,
    durationMs: number
): string {
    const digest = createHash('sha1')
        .update(`${filePath}|${startMs}|${durationMs}`)
        .digest('hex');
    return `seg_${digest.slice(0, 16)}`;
}

export interface UpsertResult {
    id: number;
    status: 'added' | 'changed' | 'unchanged';
}

/** B4 写回打标结果时用的形状 */
export interface SegmentTagInput {
    description: string;
    tags: string[];
    subjectX?: number;
    subjectY?: number;
    orientation?: string;
    hasFaces?: boolean;
}

export interface IndexStats {
    files: number;
    probed: number;
    probeFailed: number;
    keyframed: number;
    keyframeFailed: number;
    segments: number;
    tagged: number;
    keyframeImages: number;
}

/** v2 相对 v1 新增的列。DDL 里的 `if not exists` 管不到已存在的表，旧库要靠它补齐 */
const ADDED_IN_V2: readonly { table: string; column: string; ddl: string }[] = [
    {
        table: 'media_files',
        column: 'kind',
        ddl: "text not null default 'video'"
    },
    { table: 'media_files', column: 'audio_codec', ddl: 'text' },
    { table: 'media_files', column: 'rotation_degrees', ddl: 'integer' },
    { table: 'media_files', column: 'bit_rate_bps', ddl: 'integer' },
    { table: 'media_files', column: 'thumbnail_path', ddl: 'text' },
    { table: 'keyframes', column: 'avg_color', ddl: 'text' }
];

/**
 * 逐级升库。
 *
 * **加列而不是重建**：索引里的打标结果是花过模型钱的，重建就得重新花一遍。
 *
 * v1 → v2 还要把所有行的探测状态打回 `pending`。单纯补列会留下一批"状态是 ok、
 * 但旋转角度和真实类型都是空"的行——v1 根本没存过这两样，而竖拍素材的宽高
 * 要靠旋转角度换过来，不重探就会一直按横的渲染。重探只跑 ffprobe，不动关键帧，
 * 也就不会触发片段重建，打标结果原样保留。
 */
function migrate(db: SqliteDatabase, from: number): void {
    if (from >= SCHEMA_VERSION) return;

    for (const { table, column, ddl } of ADDED_IN_V2) {
        const columns = (db.all(`pragma table_info(${table})`) as Row[]).map(
            (row) => String(row['name'])
        );
        // 表还不存在（全新库）：轮不到加列，紧随其后的 DDL 会按最新结构建出来
        if (columns.length === 0 || columns.includes(column)) continue;
        db.run(`alter table ${table} add column ${column} ${ddl}`);
    }

    // from === 0 是全新库，没有行要修
    if (from >= 1) {
        db.run(
            `update media_files
                set probe_state = 'pending', probe_error = null
              where probe_state = 'ok'`
        );
    }
}

export class MediaIndexDb {
    private readonly db: SqliteDatabase;

    private constructor(db: SqliteDatabase) {
        this.db = db;
    }

    /**
     * 打开（或新建）索引库。
     *
     * **父目录不存在就先建。** 不建的话驱动只会给一句
     * `Could not open the database`，看不出是路径问题；而桌面端首次启动时
     * `userData/media-index/` 本来就不存在。
     */
    static open(file: string): MediaIndexDb {
        if (file !== ':memory:' && file !== '') {
            mkdirSync(path.dirname(path.resolve(file)), { recursive: true });
        }
        const db = new Database(file);
        // 外键默认就是开的，但显式声明一次：keyframes/asset_segments 的级联删除全靠它
        db.run('pragma foreign_keys = on');

        const current = Number(
            (db.get('pragma user_version') as Row | null)?.['user_version'] ?? 0
        );
        if (current > SCHEMA_VERSION) {
            db.close();
            throw new Error(
                `索引库版本 ${current} 高于本程序支持的 ${SCHEMA_VERSION}。请升级应用，或删除索引库重建。`
            );
        }

        // 升级**先于** DDL：DDL 里有建在新列上的索引，列还没加就执行会直接报错
        migrate(db, current);
        db.exec(DDL);
        db.run(`pragma user_version = ${SCHEMA_VERSION}`);

        return new MediaIndexDb(db);
    }

    close(): void {
        this.db.close();
    }

    /** 事务。回调抛错则整体回滚——单个文件的探测/抽帧/片段必须同进同出 */
    transaction<T>(fn: () => T): T {
        this.db.exec('begin');
        try {
            const result = fn();
            this.db.exec('commit');
            return result;
        } catch (error) {
            this.db.exec('rollback');
            throw error;
        }
    }

    // ── 扫描 ──────────────────────────────────────────────────────────────

    /**
     * 上次扫描完成于何时（epoch ms）。从没扫过为 null。
     *
     * 增量扫描靠的是**每个文件的指纹**（`content_key`），不是这个时间戳——
     * 按 mtime > lastScan 过滤会漏掉"改了内容但把 mtime 改回去"的文件，
     * 也会在系统时钟回拨后整轮失效。这里记时间只为了能对用户说
     * "距上次扫描 3 天"，以及排查"为什么这个文件没被扫到"。
     */
    getLastScanAt(): number | null {
        const row = this.db.get(
            "select value from index_meta where key = 'last_scan_at'"
        ) as Row | null;
        if (!row) return null;
        const parsed = Number(row['value']);
        return Number.isFinite(parsed) ? parsed : null;
    }

    setLastScanAt(at: number): void {
        this.db.run(
            `insert into index_meta (key, value) values ('last_scan_at', ?)
             on conflict(key) do update set value = excluded.value`,
            [String(Math.round(at))]
        );
    }

    /**
     * 登记一个扫描到的文件，返回它是新增、变更还是没动。
     *
     * 判定为「变更」时把探测与抽帧状态**双双重置为 pending**，并清掉旧的关键帧与片段。
     * 不清的话，一个被重新导出过的文件会留着旧时长——下游据此裁出来的 clip 会超出源片长度。
     */
    upsertScannedFile(file: ScannedFile): UpsertResult {
        const key = contentKeyOf(file);
        const now = Date.now();
        const existing = this.db.get(
            'select id, content_key from media_files where path = ?',
            [file.path]
        ) as Row | null;

        if (!existing) {
            const result = this.db.run(
                `insert into media_files (path, size_bytes, mtime_ms, content_key, kind, updated_at)
                 values (?, ?, ?, ?, ?, ?)`,
                [file.path, file.sizeBytes, file.mtimeMs, key, file.kind, now]
            );
            return { id: Number(result.lastInsertRowid), status: 'added' };
        }

        const id = Number(existing['id']);
        if (existing['content_key'] === key) {
            return { id, status: 'unchanged' };
        }

        this.db.run(
            `update media_files
                set size_bytes = ?, mtime_ms = ?, content_key = ?, kind = ?,
                    probe_state = 'pending', probe_error = null,
                    duration_ms = null, width = null, height = null,
                    fps = null, video_codec = null, has_audio = null,
                    audio_codec = null, rotation_degrees = null,
                    bit_rate_bps = null, thumbnail_path = null,
                    keyframe_state = 'pending', keyframe_error = null,
                    updated_at = ?
              where id = ?`,
            [file.sizeBytes, file.mtimeMs, key, file.kind, now, id]
        );
        this.deleteKeyframeRows(id);
        this.deleteSegments(id);
        return { id, status: 'changed' };
    }

    /**
     * 删掉本轮扫描没再见到的文件行。
     *
     * **只处理本次扫描根目录下的路径。** 否则"这次只扫了目录 A"会把目录 B 的索引全删了。
     * 删的是索引行与关键帧记录，不动用户的任何素材文件。
     */
    pruneMissing(
        roots: readonly string[],
        seenPaths: ReadonlySet<string>
    ): number {
        const resolved = roots.map((r) => path.resolve(r));
        const rows = this.db.all('select id, path from media_files') as Row[];
        let removed = 0;
        for (const row of rows) {
            const filePath = asString(row['path']);
            if (filePath === null || seenPaths.has(filePath)) continue;
            const underRoot = resolved.some(
                (root) =>
                    filePath === root || filePath.startsWith(root + path.sep)
            );
            if (!underRoot) continue;
            this.db.run('delete from media_files where id = ?', [
                Number(row['id'])
            ]);
            removed += 1;
        }
        return removed;
    }

    // ── 探测 ──────────────────────────────────────────────────────────────

    /**
     * 落探测结果。
     *
     * **`kind` 一并覆盖**：扫描时那个是按扩展名的初判，而 `.mp4` 与 `.m4a`
     * 文件头一模一样，分不出里面有没有视频流。探测过后这里才是真的。
     */
    saveProbe(fileId: number, probe: ProbeResult): void {
        this.db.run(
            `update media_files
                set probe_state = 'ok', probe_error = null, kind = ?,
                    duration_ms = ?, width = ?, height = ?, fps = ?,
                    video_codec = ?, has_audio = ?, audio_codec = ?,
                    rotation_degrees = ?, bit_rate_bps = ?, updated_at = ?
              where id = ?`,
            [
                probe.kind,
                probe.durationMs,
                probe.width,
                probe.height,
                probe.fps,
                probe.videoCodec,
                boolToInt(probe.hasAudio),
                probe.audioCodec,
                probe.rotationDegrees,
                probe.bitRateBps,
                Date.now(),
                fileId
            ]
        );
    }

    failProbe(fileId: number, message: string): void {
        // 探测失败就没有时长，抽帧也无从谈起，一并标失败免得下一轮又去试
        this.db.run(
            `update media_files
                set probe_state = 'failed', probe_error = ?,
                    keyframe_state = 'failed', keyframe_error = '探测失败，未抽帧',
                    updated_at = ?
              where id = ?`,
            [message.slice(0, 2000), Date.now(), fileId]
        );
    }

    // ── 关键帧 ────────────────────────────────────────────────────────────

    saveKeyframes(fileId: number, frames: readonly Keyframe[]): void {
        this.deleteKeyframeRows(fileId);
        for (const frame of frames) {
            this.db.run(
                'insert into keyframes (file_id, at_ms, path, avg_color) values (?, ?, ?, ?)',
                [fileId, frame.atMs, frame.path, frame.avgColor]
            );
        }
        this.db.run(
            `update media_files set keyframe_state = 'ok', keyframe_error = null, updated_at = ?
              where id = ?`,
            [Date.now(), fileId]
        );
    }

    /** 素材列表的预览图。纯音频没有画面，不会有这一行 */
    saveThumbnail(fileId: number, thumbnailPath: string): void {
        this.db.run(
            'update media_files set thumbnail_path = ?, updated_at = ? where id = ?',
            [thumbnailPath, Date.now(), fileId]
        );
    }

    failKeyframes(fileId: number, message: string): void {
        this.db.run(
            `update media_files set keyframe_state = 'failed', keyframe_error = ?, updated_at = ?
              where id = ?`,
            [message.slice(0, 2000), Date.now(), fileId]
        );
    }

    listKeyframes(fileId: number): Keyframe[] {
        const rows = this.db.all(
            'select at_ms, path, avg_color from keyframes where file_id = ? order by at_ms',
            [fileId]
        ) as Row[];
        return rows.map((r) => ({
            atMs: Number(r['at_ms']),
            path: String(r['path']),
            avgColor: asString(r['avg_color'])
        }));
    }

    private deleteKeyframeRows(fileId: number): void {
        this.db.run('delete from keyframes where file_id = ?', [fileId]);
    }

    // ── 片段 ──────────────────────────────────────────────────────────────

    /**
     * 用一组新片段替换该文件现有的全部片段。
     *
     * v1 只会传一段（整片），但接口按多段写——长片按场景切分是 P2 的事，
     * 到时候只改调用方传什么，这里和下游都不用动。
     */
    replaceSegments(
        fileId: number,
        filePath: string,
        segments: readonly { startMs: number; durationMs: number }[]
    ): string[] {
        this.deleteSegments(fileId);
        const now = Date.now();
        const fileName = normalizeFileName(path.basename(filePath));
        const ids: string[] = [];

        for (const seg of segments) {
            const id = segmentIdFor(filePath, seg.startMs, seg.durationMs);
            this.db.run(
                `insert into asset_segments (id, file_id, start_ms, duration_ms, updated_at)
                 values (?, ?, ?, ?, ?)`,
                [id, fileId, seg.startMs, seg.durationMs, now]
            );
            // 打标前先用文件名建索引：素材名往往自带语义（"办公室-中景-01.mp4"），
            // 这样 B4 还没跑完就已经能检索，也让 B3 自身可验证
            this.syncFts(id, fileName, null, []);
            ids.push(id);
        }
        return ids;
    }

    private deleteSegments(fileId: number): void {
        const rows = this.db.all(
            'select id from asset_segments where file_id = ?',
            [fileId]
        ) as Row[];
        for (const row of rows) {
            this.db.run('delete from asset_fts where segment_id = ?', [
                String(row['id'])
            ]);
        }
        this.db.run('delete from asset_segments where file_id = ?', [fileId]);
    }

    /** B4 写回打标结果 */
    saveSegmentTags(segmentId: string, input: SegmentTagInput): void {
        const row = this.db.get(
            `select s.id, f.path from asset_segments s
               join media_files f on f.id = s.file_id
              where s.id = ?`,
            [segmentId]
        ) as Row | null;
        if (!row) throw new Error(`片段不存在：${segmentId}`);

        this.db.run(
            `update asset_segments
                set tag_state = 'ok', tag_error = null,
                    description = ?, tags = ?, subject_x = ?, subject_y = ?,
                    orientation = ?, has_faces = ?, updated_at = ?
              where id = ?`,
            [
                input.description,
                JSON.stringify(input.tags),
                input.subjectX ?? null,
                input.subjectY ?? null,
                input.orientation ?? null,
                boolToInt(input.hasFaces ?? null),
                Date.now(),
                segmentId
            ]
        );
        this.syncFts(
            segmentId,
            normalizeFileName(path.basename(String(row['path']))),
            input.description,
            input.tags
        );
    }

    failSegmentTags(segmentId: string, message: string): void {
        this.db.run(
            `update asset_segments set tag_state = 'failed', tag_error = ?, updated_at = ?
              where id = ?`,
            [message.slice(0, 2000), Date.now(), segmentId]
        );
    }

    listSegmentsByTagState(state: StageState, limit = 100): AssetSegment[] {
        const rows = this.db.all(
            'select * from asset_segments where tag_state = ? order by rowid limit ?',
            [state, limit]
        ) as Row[];
        return rows.map(toAssetSegment);
    }

    /**
     * FTS 行的唯一写入口。
     *
     * 先删后插，不做 update——FTS5 的外部内容同步稍有遗漏就会静默漂移，
     * 而漂移的症状是"某些素材永远搜不到"，极难发现。全部收在这一个函数里，只需保证这里对。
     */
    private syncFts(
        segmentId: string,
        fileName: string,
        description: string | null,
        tags: readonly string[]
    ): void {
        this.db.run('delete from asset_fts where segment_id = ?', [segmentId]);
        this.db.run(
            'insert into asset_fts (segment_id, filename, description, tags) values (?, ?, ?, ?)',
            [
                segmentId,
                toIndexText(fileName),
                toIndexText(description),
                toIndexText(tags.join(' '))
            ]
        );
    }

    // ── 检索 ──────────────────────────────────────────────────────────────

    /**
     * plan.md §8 的检索：**先硬过滤，再 BM25 排序**。
     *
     * 查询串为空（或切不出任何 token）时退化为纯过滤 + 按时长降序——
     * 空串交给 MATCH 是语法错误，必须走另一条分支。
     */
    search(query: string, filters: SearchFilters = {}): SearchHit[] {
        const limit = filters.limit ?? 20;
        const where: string[] = [];
        const params: (string | number)[] = [];

        const match = toMatchExpression(query);
        if (match !== null) {
            where.push('asset_fts match ?');
            params.push(match);
        }
        // 只在已探测成功的文件里检索：没有时长的行既过不了硬过滤，也不该被选中
        where.push("f.probe_state = 'ok'");
        // 限定在用户这次选的素材里。**不做这一步，整库的旧素材都会混进来**
        if (filters.paths !== undefined) {
            if (filters.paths.length === 0) return [];
            const clauses = filters.paths.map(
                () => "(f.path = ? or f.path like ? escape '\\')"
            );
            where.push(`(${clauses.join(' or ')})`);
            for (const item of filters.paths) {
                params.push(item);
                // like 的通配符要转义：路径里出现 % 或 _ 并不罕见
                params.push(`${escapeLike(item)}/%`);
            }
        }
        /**
         * 只要**还没打过标**的片段。
         *
         * 给检索落空时的退路用：未打标的片段 `description` 是 NULL，FTS 里只剩
         * 文件名，而文件名经常是 UUID——任何查询词都搭不上，素材在库里却等于
         * 不存在。已打标却没匹配上的则相反，那说明语义层尽职了，不该混进来。
         */
        if (filters.untaggedOnly === true) {
            where.push("s.tag_state != 'ok'");
        }
        // 不限类的话音频也会被选中——它同样带文件名进了 FTS，
        // 拿去配画面就得到一段没有画面的"镜头"
        if (filters.kinds !== undefined) {
            if (filters.kinds.length === 0) return [];
            where.push(
                `f.kind in (${filters.kinds.map(() => '?').join(', ')})`
            );
            params.push(...filters.kinds);
        }
        if (filters.minDurationMs !== undefined) {
            where.push('s.duration_ms >= ?');
            params.push(filters.minDurationMs);
        }
        if (filters.minWidth !== undefined) {
            where.push('f.width >= ?');
            params.push(filters.minWidth);
        }
        if (filters.minHeight !== undefined) {
            where.push('f.height >= ?');
            params.push(filters.minHeight);
        }
        if (filters.hasAudio !== undefined) {
            where.push('f.has_audio = ?');
            params.push(filters.hasAudio ? 1 : 0);
        }

        const selectScore = match !== null ? 'bm25(asset_fts)' : '0';
        // **必须带 tie-break**：BM25 打平在小库上很常见（B5 的用例里一抓一大把），
        // 而 SQLite 对同分行的顺序不作保证。少了 `s.id`，同一份输入两次调用
        // 就可能返回不同的 Top-N，B5「结果稳定」那条 DoD 直接破掉
        const orderBy =
            match !== null
                ? 'score asc, s.id asc'
                : 's.duration_ms desc, s.id asc';
        const from =
            match !== null
                ? `asset_fts
                   join asset_segments s on s.id = asset_fts.segment_id
                   join media_files    f on f.id = s.file_id`
                : `asset_segments s
                   join media_files f on f.id = s.file_id`;

        params.push(limit);
        const rows = this.db.all(
            `select s.id, s.file_id, s.start_ms, s.duration_ms, s.description, s.tags,
                    f.path, f.kind, f.width, f.height, f.has_audio, ${selectScore} as score
               from ${from}
              where ${where.join(' and ')}
              order by ${orderBy}
              limit ?`,
            params
        ) as Row[];

        return rows.map((r) => ({
            segmentId: String(r['id']),
            fileId: Number(r['file_id']),
            path: String(r['path']),
            kind: toMediaKind(r['kind']),
            startMs: Number(r['start_ms']),
            durationMs: Number(r['duration_ms']),
            description: asString(r['description']),
            tags: parseTags(r['tags']),
            width: asInt(r['width']),
            height: asInt(r['height']),
            hasAudio: intToBool(r['has_audio']),
            score: Number(r['score'])
        }));
    }

    // ── 查询与统计 ────────────────────────────────────────────────────────

    /**
     * 按内部 id 取文件。
     *
     * B4 打标需要它：`AssetSegment` 上只有 `fileId`，而文件名本身带语义
     * （「办公室-中景-01.mp4」），作为提示词的上下文很有用。
     */
    getFileById(id: number): MediaFileRecord | null {
        const row = this.db.get('select * from media_files where id = ?', [
            id
        ]) as Row | null;
        return row ? toMediaFileRecord(row) : null;
    }

    getFileByPath(filePath: string): MediaFileRecord | null {
        const row = this.db.get('select * from media_files where path = ?', [
            filePath
        ]) as Row | null;
        return row ? toMediaFileRecord(row) : null;
    }

    /**
     * 还没处理完的文件：探测或抽帧仍为 pending。
     *
     * 这就是断点续跑的全部依据——**中途被 kill 的文件不会留下 'ok'**，
     * 因为每个文件的落库都在一个事务里，要么全成要么全无。
     */
    listUnfinishedFiles(limit = 100_000): MediaFileRecord[] {
        const rows = this.db.all(
            `select * from media_files
              where probe_state = 'pending' or keyframe_state = 'pending'
              order by id limit ?`,
            [limit]
        ) as Row[];
        return rows.map(toMediaFileRecord);
    }

    /**
     * 每个文件切出了几段、打了几段标。
     *
     * `stats()` 给的是**整个库**的合计，而界面要报的是"你这次选的这些文件"——
     * 库里可能还留着上次索引的别的目录，拿合计去说当前这次选择是不准的。
     *
     * 按 path 返回，调用方自己按选中的路径过滤：路径里可能带 `%` `_`，
     * 用 SQL 的 like 反而要处理转义，得不偿失。
     */
    fileSummaries(): { path: string; segments: number; tagged: number }[] {
        const rows = this.db.all(
            `select f.path                                            as path,
                    count(s.id)                                       as segments,
                    sum(case when s.tag_state = 'ok' then 1 else 0 end) as tagged
               from media_files f
               left join asset_segments s on s.file_id = f.id
              group by f.id
              order by f.path`
        ) as Row[];

        return rows.map((row) => ({
            path: String(row['path']),
            segments: Number(row['segments'] ?? 0),
            tagged: Number(row['tagged'] ?? 0)
        }));
    }

    /**
     * 素材库的整体画像：规模 + 内容分布。
     *
     * 创作前的「分析素材」这一步要的就是它——**不调模型**，全是库里查得到的：
     * 几个文件、切了多少段、总时长多久、片段里最常出现的是什么内容。
     *
     * 标签在库里是 JSON 数组的文本，用 SQL 拆开不划算（还要处理转义），
     * 所以取回来在 JS 里聚合。片段数是千级，一次遍历无所谓。
     */
    assetOverview(topTags = 8, paths?: readonly string[]): AssetOverview {
        // 限定在用户这次选的素材里；不传才算整库。
        // **不做这一步**，库里上次索引的别的目录都会被算进来——
        // 用户只传了一个文件，准备阶段却报"3 个文件、3 个片段"，就是这么来的
        const rows = this.db.all(
            `select f.path                                             as path,
                    f.duration_ms                                      as duration,
                    s.tags                                             as tags,
                    s.tag_state                                        as tag_state
               from media_files f
               left join asset_segments s on s.file_id = f.id`
        ) as Row[];

        const inScope = rows.filter(
            (row) => paths === undefined || underAny(String(row['path']), paths)
        );

        const files = new Map<string, number>();
        const counts = new Map<string, number>();
        let segments = 0;
        let tagged = 0;

        for (const row of inScope) {
            const filePath = String(row['path']);
            if (!files.has(filePath)) {
                files.set(filePath, Number(row['duration'] ?? 0));
            }
            // left join：没有片段的文件这一列是 null，不能算成一段
            if (row['tags'] === undefined && row['tag_state'] === undefined) {
                continue;
            }
            if (row['tag_state'] === null || row['tag_state'] === undefined) {
                continue;
            }
            segments += 1;
            if (row['tag_state'] !== 'ok') continue;
            tagged += 1;

            const raw = row['tags'];
            if (typeof raw !== 'string') continue;
            let parsed: unknown;
            try {
                parsed = JSON.parse(raw);
            } catch {
                continue;
            }
            if (!Array.isArray(parsed)) continue;
            for (const tag of parsed) {
                if (typeof tag !== 'string' || tag === '') continue;
                counts.set(tag, (counts.get(tag) ?? 0) + 1);
            }
        }

        return {
            files: files.size,
            segments,
            tagged,
            totalDurationMs: [...files.values()].reduce(
                (sum, value) => sum + value,
                0
            ),
            topTags: [...counts.entries()]
                // 次数相同时按标签名排序，保证两次读到的顺序一样
                .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))
                .slice(0, topTags)
                .map(([tag, count]) => ({ tag, count }))
        };
    }

    stats(): IndexStats {
        const one = (sql: string): number =>
            Number((this.db.get(sql) as Row | null)?.['c'] ?? 0);
        return {
            files: one('select count(*) c from media_files'),
            probed: one(
                "select count(*) c from media_files where probe_state = 'ok'"
            ),
            probeFailed: one(
                "select count(*) c from media_files where probe_state = 'failed'"
            ),
            keyframed: one(
                "select count(*) c from media_files where keyframe_state = 'ok'"
            ),
            keyframeFailed: one(
                "select count(*) c from media_files where keyframe_state = 'failed'"
            ),
            segments: one('select count(*) c from asset_segments'),
            tagged: one(
                "select count(*) c from asset_segments where tag_state = 'ok'"
            ),
            keyframeImages: one('select count(*) c from keyframes')
        };
    }
}

/** like 的通配符要转义：路径里出现 % 或 _ 并不罕见 */
function escapeLike(value: string): string {
    return value.replace(/[\\%_]/g, (ch) => `\\${ch}`);
}

/** 这个文件在不在选中的范围内。选中项既可能是文件本身，也可能是目录 */
function underAny(filePath: string, roots: readonly string[]): boolean {
    return roots.some(
        (root) => filePath === root || filePath.startsWith(`${root}/`)
    );
}

function toStageState(value: unknown): StageState {
    return value === 'ok' || value === 'failed' ? value : 'pending';
}

/** 库里存的是文本。认不出就按 video——比抛错好，一行脏数据不该让整库读不出来 */
function toMediaKind(value: unknown): MediaKind {
    return value === 'audio' || value === 'image' ? value : 'video';
}

function toMediaFileRecord(row: Row): MediaFileRecord {
    const kind = toMediaKind(row['kind']);

    /**
     * **以 `probe_state` 为准，不以字段齐不齐为准。**
     *
     * 以前这里要求 width/height/fps 都非空才认，于是纯音频——它们本来就该是
     * null——探测成功了也读回 `probe: null`，管线每一轮都判定它"还没探测过"
     * 而重跑一遍 ffprobe。增量扫描在音频上直接失效，且无声无息。
     */
    const probe: ProbeResult | null =
        toStageState(row['probe_state']) === 'ok'
            ? {
                  kind,
                  durationMs: asInt(row['duration_ms']) ?? 0,
                  width: asInt(row['width']),
                  height: asInt(row['height']),
                  fps: typeof row['fps'] === 'number' ? row['fps'] : null,
                  videoCodec: asString(row['video_codec']),
                  hasAudio: intToBool(row['has_audio']) ?? false,
                  audioCodec: asString(row['audio_codec']),
                  rotationDegrees: asInt(row['rotation_degrees']) ?? 0,
                  bitRateBps: asInt(row['bit_rate_bps'])
              }
            : null;

    return {
        id: Number(row['id']),
        path: String(row['path']),
        sizeBytes: Number(row['size_bytes']),
        mtimeMs: Number(row['mtime_ms']),
        kind,
        probeState: toStageState(row['probe_state']),
        probeError: asString(row['probe_error']),
        keyframeState: toStageState(row['keyframe_state']),
        keyframeError: asString(row['keyframe_error']),
        probe,
        thumbnailPath: asString(row['thumbnail_path'])
    };
}

function toAssetSegment(row: Row): AssetSegment {
    return {
        id: String(row['id']),
        fileId: Number(row['file_id']),
        startMs: Number(row['start_ms']),
        durationMs: Number(row['duration_ms']),
        tagState: toStageState(row['tag_state']),
        description: asString(row['description']),
        tags: parseTags(row['tags']),
        subjectX:
            typeof row['subject_x'] === 'number' ? row['subject_x'] : null,
        subjectY:
            typeof row['subject_y'] === 'number' ? row['subject_y'] : null,
        orientation: asString(row['orientation']),
        hasFaces: intToBool(row['has_faces'])
    };
}
