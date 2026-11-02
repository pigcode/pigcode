/** 管理 SQLite schema 版本；迁移只向前。 */
import type Database from "better-sqlite3"

/** 一次迁移：一段 SQL，或者需要先看当前 schema 再决定怎么改的函数。 */
type Migration = string | ((db: Database.Database) => void)

/**
 * v7 的改名：Agent 以前叫 provider（#33），表和列改成新名字。外键、索引、触发器都不引用这些列，
 * provider_sessions 也没有被别的表的外键引用；RENAME 时 SQLite 会同步改写引用它们的 schema。
 */
const AGENT_RENAMES = {
  tables: [["provider_sessions", "agent_sessions"]],
  columns: [
    ["threads", "default_provider_id", "default_agent_id"],
    ["threads", "last_provider_id", "last_agent_id"],
    ["agent_sessions", "provider_id", "agent_id"],
    ["runs", "provider_session_id", "agent_session_id"],
    ["pending_requests", "provider_request_id", "agent_request_id"],
  ],
} as const

/**
 * v7：按 AGENT_RENAMES 改名。只改还叫旧名字的表和列，重复执行不报错也不改动。
 * 新旧名字同时存在说明有人手工改过库：旧的那份没有数据时跳过，有数据时报错停下，
 * 不悄悄丢掉它（迁移在事务里，报错时库原样不动）。
 */
function renameAgentColumns(db: Database.Database): void {
  const tables = new Set(
    db.prepare(`SELECT name FROM sqlite_master WHERE type = 'table'`).pluck().all() as string[],
  )
  const count = (sql: string) => db.prepare(sql).pluck().get() as number
  for (const [from, to] of AGENT_RENAMES.tables) {
    if (!tables.has(from)) continue
    if (!tables.has(to)) {
      db.exec(`ALTER TABLE ${from} RENAME TO ${to}`)
      continue
    }
    if (count(`SELECT COUNT(*) FROM ${from}`) > 0) {
      throw new Error(`cannot rename table ${from} to ${to}: both exist and ${from} has rows`)
    }
  }
  for (const [table, from, to] of AGENT_RENAMES.columns) {
    const columns = new Set(
      (db.pragma(`table_info(${table})`) as Array<{ name: string }>).map((column) => column.name),
    )
    if (!columns.has(from)) continue
    if (!columns.has(to)) {
      db.exec(`ALTER TABLE ${table} RENAME COLUMN ${from} TO ${to}`)
      continue
    }
    if (count(`SELECT COUNT(*) FROM ${table} WHERE ${from} IS NOT NULL`) > 0) {
      throw new Error(
        `cannot rename ${table}.${from} to ${to}: both columns exist and ${from} has values`,
      )
    }
  }
  // 失败 run 的错误码也跟着改名；没有代码按它判断，只是让库里不再出现旧名字。
  if (tables.has("runs")) {
    db.prepare(
      `UPDATE runs SET error_code = 'AGENT_ERROR' WHERE error_code = 'PROVIDER_ERROR'`,
    ).run()
  }
}

/**
 * v8 的改名：持久事件 payload 里的旧字段名（#34）。界面直接读这些事件，旧事件和新事件要用同一套字段名。
 */
const EVENT_PAYLOAD_RENAMES = [
  ["run.started", "providerId", "agentId"],
  ["run.started", "providerSessionId", "agentSessionId"],
  ["thread.updated", "providerId", "agentId"],
] as const

/**
 * v8：按 EVENT_PAYLOAD_RENAMES 改写 thread_events 的 payload_json。只改还带旧字段的事件，重复执行不改动；
 * 新旧字段同时存在时保留新字段的值，删掉旧字段。payload 不是合法 JSON 的事件原样保留。
 * 没有 thread_events 表（只造了部分 schema 的测试库）时什么都不做。
 */
function renameEventPayloadKeys(db: Database.Database): void {
  const exists = db
    .prepare(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'thread_events'`)
    .get()
  if (!exists) return
  const rename = db.prepare(`
    UPDATE thread_events
    SET payload_json = json_remove(
      CASE
        WHEN json_type(payload_json, '$.' || :to) IS NULL
          THEN json_set(payload_json, '$.' || :to, json(payload_json -> ('$.' || :from)))
        ELSE payload_json
      END,
      '$.' || :from
    )
    WHERE type = :type
      AND (CASE WHEN json_valid(payload_json) THEN json_type(payload_json, '$.' || :from) END)
        IS NOT NULL
  `)
  for (const [type, from, to] of EVENT_PAYLOAD_RENAMES) rename.run({ type, from, to })
}

const MIGRATIONS: Migration[] = [
  `
  CREATE TABLE IF NOT EXISTS projects (
    id TEXT PRIMARY KEY,
    root_path TEXT NOT NULL UNIQUE,
    name TEXT NOT NULL,
    created_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS threads (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL REFERENCES projects(id),
    title TEXT NOT NULL,
    default_provider_id TEXT NOT NULL,
    last_provider_id TEXT,
    last_model_id TEXT,
    permission_mode TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    archived_at TEXT,
    last_run_id TEXT
  );

  CREATE TABLE IF NOT EXISTS runs (
    id TEXT PRIMARY KEY,
    thread_id TEXT NOT NULL REFERENCES threads(id),
    provider_session_id TEXT NOT NULL,
    status TEXT NOT NULL,
    started_at TEXT NOT NULL,
    completed_at TEXT,
    error_code TEXT,
    error_message TEXT,
    checkpoint_id TEXT
  );

  CREATE TABLE IF NOT EXISTS thread_events (
    seq INTEGER PRIMARY KEY AUTOINCREMENT,
    thread_id TEXT NOT NULL,
    run_id TEXT,
    type TEXT NOT NULL,
    payload_json TEXT NOT NULL,
    schema_version INTEGER NOT NULL,
    created_at TEXT NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_thread_events_thread_seq
    ON thread_events(thread_id, seq);

  CREATE TABLE IF NOT EXISTS command_receipts (
    command_id TEXT PRIMARY KEY,
    result_json TEXT NOT NULL,
    created_at TEXT NOT NULL
  );
  `,
  `
  CREATE TABLE IF NOT EXISTS provider_sessions (
    id TEXT PRIMARY KEY,
    thread_id TEXT NOT NULL REFERENCES threads(id),
    provider_id TEXT NOT NULL,
    native_session_id TEXT,
    cwd TEXT NOT NULL,
    status TEXT NOT NULL,
    created_at TEXT NOT NULL,
    stopped_at TEXT
  );

  CREATE TABLE IF NOT EXISTS pending_requests (
    id TEXT PRIMARY KEY,
    thread_id TEXT NOT NULL REFERENCES threads(id),
    run_id TEXT NOT NULL REFERENCES runs(id),
    kind TEXT NOT NULL,
    provider_request_id TEXT,
    payload_json TEXT NOT NULL,
    status TEXT NOT NULL,
    created_at TEXT NOT NULL,
    resolved_at TEXT
  );

  CREATE INDEX IF NOT EXISTS idx_pending_requests_thread_status
    ON pending_requests(thread_id, status);
  `,
  `
  CREATE TABLE IF NOT EXISTS checkpoints (
    id TEXT PRIMARY KEY,
    thread_id TEXT NOT NULL REFERENCES threads(id),
    run_id TEXT,
    phase TEXT NOT NULL,
    git_ref TEXT NOT NULL,
    commit_sha TEXT,
    label TEXT,
    created_at TEXT NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_checkpoints_thread_created
    ON checkpoints(thread_id, created_at);

  CREATE TABLE IF NOT EXISTS worktrees (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL REFERENCES projects(id),
    thread_id TEXT NOT NULL REFERENCES threads(id),
    path TEXT NOT NULL UNIQUE,
    branch TEXT,
    status TEXT NOT NULL,
    created_at TEXT NOT NULL,
    removed_at TEXT
  );
  `,
  `
  CREATE TABLE IF NOT EXISTS schedules (
    id TEXT PRIMARY KEY,
    thread_id TEXT NOT NULL REFERENCES threads(id),
    prompt TEXT NOT NULL,
    interval_seconds INTEGER NOT NULL,
    enabled INTEGER NOT NULL,
    next_run_at TEXT NOT NULL,
    last_run_at TEXT,
    last_run_id TEXT,
    created_at TEXT NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_schedules_next_run
    ON schedules(enabled, next_run_at);
  `,
  `
  ALTER TABLE projects ADD COLUMN archived_at TEXT;
  `,
  `
  ALTER TABLE threads ADD COLUMN parent_thread_id TEXT REFERENCES threads(id);

  CREATE INDEX IF NOT EXISTS idx_threads_parent ON threads(parent_thread_id);
  `,
  renameAgentColumns,
  renameEventPayloadKeys,
]

/** 最新的 schema 版本，也就是迁移的个数。 */
export const SCHEMA_VERSION = MIGRATIONS.length

/** 数据库当前的 schema 版本。 */
export function schemaVersion(db: Database.Database): number {
  return db.pragma("user_version", { simple: true }) as number
}

/**
 * 按 user_version 执行缺失迁移，默认迁到最新；测试可以只迁到某个旧版本，造出旧数据库。
 * 每个迁移和它的版本号在同一个事务里提交：中途退出不会留下改了一半、版本号却没变的库。
 */
export function migrate(db: Database.Database, target: number = SCHEMA_VERSION): void {
  const step = db.transaction((version: number) => {
    const migration = MIGRATIONS[version]!
    if (typeof migration === "string") db.exec(migration)
    else migration(db)
    db.pragma(`user_version = ${version + 1}`)
  })
  for (let version = schemaVersion(db); version < target; version += 1) step(version)
}
