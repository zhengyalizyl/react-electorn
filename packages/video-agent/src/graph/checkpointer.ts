import { mkdirSync } from 'node:fs';
import path from 'node:path';
import sqlite3 from 'node-sqlite3-wasm';

import type { RunnableConfig } from '@langchain/core/runnables';
import type {
    ChannelVersions,
    Checkpoint,
    CheckpointListOptions,
    CheckpointMetadata,
    CheckpointTuple,
    PendingWrite,
    SerializerProtocol
} from '@langchain/langgraph-checkpoint';
import {
    BaseCheckpointSaver,
    WRITES_IDX_MAP
} from '@langchain/langgraph-checkpoint';

/**
 * 落在 SQLite 上的 LangGraph checkpointer（plan.md §9.4）。
 *
 * ## 为什么要自己写
 *
 * 官方的 `@langchain/langgraph-checkpoint-sqlite` 依赖 **better-sqlite3**，
 * 而 B3 已经明确避开原生模块（plan.md §8.2）：原生模块要为 Electron 重编译，
 * 编译完 vitest 就加载不了，反之亦然。为了一个 checkpointer 把那个问题放回来不划算。
 *
 * 这里用与索引库同一个驱动 `node-sqlite3-wasm`，实现 `BaseCheckpointSaver` 的
 * 五个抽象方法。`getDeltaChannelHistory` 与 `getNextVersion` 走基类默认实现。
 *
 * ## 与 §9.1 铁律的关系
 *
 * **checkpoint 是派生的运行态，不是工程的真源。** 工程的唯一真源始终是
 * `project.json`。删掉 checkpoint 只应导致"这次运行要重来"，
 * 不应损失任何已保存的工程。
 */

const { Database } = sqlite3;
type SqliteDatabase = InstanceType<typeof Database>;
type Row = Record<string, unknown>;

const DDL = `
create table if not exists checkpoints (
    thread_id     text not null,
    checkpoint_ns text not null default '',
    checkpoint_id text not null,
    parent_id     text,
    type          text,
    checkpoint    text not null,
    metadata      text not null,
    primary key (thread_id, checkpoint_ns, checkpoint_id)
);

create table if not exists checkpoint_writes (
    thread_id     text not null,
    checkpoint_ns text not null default '',
    checkpoint_id text not null,
    task_id       text not null,
    idx           integer not null,
    channel       text not null,
    type          text,
    value         text,
    primary key (thread_id, checkpoint_ns, checkpoint_id, task_id, idx)
);

create index if not exists idx_checkpoints_thread
    on checkpoints(thread_id, checkpoint_ns, checkpoint_id desc);
`;

interface ConfigurableParts {
    threadId: string;
    checkpointNs: string;
    checkpointId?: string;
}

function readConfig(config: RunnableConfig): ConfigurableParts {
    const configurable = (config.configurable ?? {}) as Record<string, unknown>;
    const threadId = configurable['thread_id'];
    if (typeof threadId !== 'string' || threadId.length === 0) {
        throw new Error('checkpointer 需要 configurable.thread_id');
    }
    const ns = configurable['checkpoint_ns'];
    const id = configurable['checkpoint_id'];
    return {
        threadId,
        checkpointNs: typeof ns === 'string' ? ns : '',
        ...(typeof id === 'string' && id.length > 0 ? { checkpointId: id } : {})
    };
}

function toConfig(
    threadId: string,
    checkpointNs: string,
    checkpointId: string
): RunnableConfig {
    return {
        configurable: {
            thread_id: threadId,
            checkpoint_ns: checkpointNs,
            checkpoint_id: checkpointId
        }
    };
}

/**
 * 序列化字节 ↔ base64 文本。
 *
 * ## 为什么不直接存 blob
 *
 * `serde.dumpsTyped` 返回的 `Uint8Array` **可能来自另一个 realm**——
 * vitest 的 jsdom 环境里，被转译的模块与外部化的 node 依赖处在不同的
 * JS 上下文里，`value instanceof Uint8Array` 直接是 `false`，
 * 驱动的类型判断认不出来，报 `Unsupported type for binding: "object"`。
 *
 * 字符串是原语，不属于任何 realm。用 base64 之后这一整类问题消失，
 * 代价是体积涨三分之一——checkpoint 只有几 KB，不值一提。
 *
 * ⚠️ 这里改过列类型（blob → text）。旧的 checkpoint 库读不了，
 * 但它是**派生的运行态**（plan.md §9.1），删掉只意味着这次运行要重来。
 */
function encodeBytes(bytes: Uint8Array): string {
    return Buffer.from(bytes).toString('base64');
}

function decodeBytes(value: unknown): Uint8Array {
    if (typeof value !== 'string') {
        throw new Error('checkpoint 存储里读到了非文本的值');
    }
    // `Uint8Array.from` 用当前 realm 的构造器，确保交给 serde 的类型是它认得的
    return Uint8Array.from(Buffer.from(value, 'base64'));
}

/**
 * 打开前先建好父目录。
 *
 * 不建的话驱动只会给一句 `Could not open the database`，看不出是路径不存在。
 * 而这**不是只有命令行才会碰到**：桌面端首次启动时
 * `userData/agent/checkpoints.db` 的父目录同样不存在。
 */
function ensureParentDir(file: string): void {
    if (file === ':memory:' || file === '') return;
    mkdirSync(path.dirname(path.resolve(file)), { recursive: true });
}

export class SqliteWasmSaver extends BaseCheckpointSaver {
    private readonly db: SqliteDatabase;

    private constructor(db: SqliteDatabase, serde?: SerializerProtocol) {
        super(serde);
        this.db = db;
    }

    /** `:memory:` 用于测试；给路径则落盘 */
    static open(file: string, serde?: SerializerProtocol): SqliteWasmSaver {
        ensureParentDir(file);
        const db = new Database(file);
        db.run('pragma foreign_keys = on');
        db.exec(DDL);
        return new SqliteWasmSaver(db, serde);
    }

    close(): void {
        this.db.close();
    }

    async getTuple(
        config: RunnableConfig
    ): Promise<CheckpointTuple | undefined> {
        const { threadId, checkpointNs, checkpointId } = readConfig(config);

        // 不给 checkpoint_id 就取最新的一个：LangGraph 恢复线程时走这条
        const row = (
            checkpointId
                ? this.db.get(
                      `select * from checkpoints
                        where thread_id = ? and checkpoint_ns = ? and checkpoint_id = ?`,
                      [threadId, checkpointNs, checkpointId]
                  )
                : this.db.get(
                      `select * from checkpoints
                        where thread_id = ? and checkpoint_ns = ?
                        order by checkpoint_id desc limit 1`,
                      [threadId, checkpointNs]
                  )
        ) as Row | null;

        if (!row) return undefined;

        const id = String(row['checkpoint_id']);
        const type = row['type'] === null ? undefined : String(row['type']);

        const checkpoint = (await this.serde.loadsTyped(
            type ?? 'json',
            decodeBytes(row['checkpoint'])
        )) as Checkpoint;
        const metadata = (await this.serde.loadsTyped(
            type ?? 'json',
            decodeBytes(row['metadata'])
        )) as CheckpointMetadata;

        const writeRows = this.db.all(
            `select task_id, channel, type, value from checkpoint_writes
              where thread_id = ? and checkpoint_ns = ? and checkpoint_id = ?
              order by task_id, idx`,
            [threadId, checkpointNs, id]
        ) as Row[];

        const pendingWrites: CheckpointTuple['pendingWrites'] = [];
        for (const write of writeRows) {
            pendingWrites.push([
                String(write['task_id']),
                String(write['channel']),
                await this.serde.loadsTyped(
                    write['type'] === null ? 'json' : String(write['type']),
                    decodeBytes(write['value'])
                )
            ]);
        }

        const parentId = row['parent_id'];
        return {
            config: toConfig(threadId, checkpointNs, id),
            checkpoint,
            metadata,
            ...(typeof parentId === 'string' && parentId.length > 0
                ? { parentConfig: toConfig(threadId, checkpointNs, parentId) }
                : {}),
            pendingWrites
        };
    }

    async *list(
        config: RunnableConfig,
        options?: CheckpointListOptions
    ): AsyncGenerator<CheckpointTuple> {
        const { threadId, checkpointNs } = readConfig(config);
        const params: (string | number)[] = [threadId, checkpointNs];
        let sql = `select checkpoint_id from checkpoints
                    where thread_id = ? and checkpoint_ns = ?`;

        if (options?.before?.configurable?.['checkpoint_id']) {
            sql += ' and checkpoint_id < ?';
            params.push(String(options.before.configurable['checkpoint_id']));
        }
        // 新的在前：LangGraph 拿列表是为了找最近的状态
        sql += ' order by checkpoint_id desc';
        if (options?.limit !== undefined) {
            sql += ' limit ?';
            params.push(options.limit);
        }

        const rows = this.db.all(sql, params) as Row[];
        for (const row of rows) {
            const tuple = await this.getTuple(
                toConfig(threadId, checkpointNs, String(row['checkpoint_id']))
            );
            if (tuple) yield tuple;
        }
    }

    async put(
        config: RunnableConfig,
        checkpoint: Checkpoint,
        metadata: CheckpointMetadata,
        // 通道版本由基类的 getNextVersion 维护，checkpoint 对象里已经带上了，
        // 这里不需要额外存一份。保留形参是为了匹配抽象签名
        // eslint-disable-next-line @typescript-eslint/no-unused-vars
        newVersions: ChannelVersions
    ): Promise<RunnableConfig> {
        const { threadId, checkpointNs, checkpointId } = readConfig(config);

        const [type, checkpointBytes] = await this.serde.dumpsTyped(checkpoint);
        const [metadataType, metadataBytes] =
            await this.serde.dumpsTyped(metadata);
        if (type !== metadataType) {
            // 两边用同一个 type 列存，序列化器给出不同类型就存不下来
            throw new Error(
                `checkpoint 与 metadata 的序列化类型不一致：${type} / ${metadataType}`
            );
        }

        this.db.run(
            `insert or replace into checkpoints
                (thread_id, checkpoint_ns, checkpoint_id, parent_id, type, checkpoint, metadata)
             values (?, ?, ?, ?, ?, ?, ?)`,
            [
                threadId,
                checkpointNs,
                checkpoint.id,
                checkpointId ?? null,
                type,
                encodeBytes(checkpointBytes),
                encodeBytes(metadataBytes)
            ]
        );

        return toConfig(threadId, checkpointNs, checkpoint.id);
    }

    async putWrites(
        config: RunnableConfig,
        writes: PendingWrite[],
        taskId: string
    ): Promise<void> {
        const { threadId, checkpointNs, checkpointId } = readConfig(config);
        if (!checkpointId) {
            throw new Error('putWrites 需要 configurable.checkpoint_id');
        }

        for (const [index, write] of writes.entries()) {
            const [channel, value] = write;
            const [type, bytes] = await this.serde.dumpsTyped(value);
            // 特殊写（如错误）映射到负索引，避免与普通写撞主键——
            // 这是 WRITES_IDX_MAP 存在的全部理由
            const idx = WRITES_IDX_MAP[channel] ?? index;
            this.db.run(
                `insert or replace into checkpoint_writes
                    (thread_id, checkpoint_ns, checkpoint_id, task_id, idx, channel, type, value)
                 values (?, ?, ?, ?, ?, ?, ?, ?)`,
                [
                    threadId,
                    checkpointNs,
                    checkpointId,
                    taskId,
                    idx,
                    channel,
                    type,
                    encodeBytes(bytes)
                ]
            );
        }
    }

    async deleteThread(threadId: string): Promise<void> {
        this.db.run('delete from checkpoint_writes where thread_id = ?', [
            threadId
        ]);
        this.db.run('delete from checkpoints where thread_id = ?', [threadId]);
    }
}
