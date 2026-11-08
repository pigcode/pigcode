/** 管理 SQLite schema 版本；迁移只向前。 */
import type Database from "better-sqlite3"

/** 一次迁移：一段 SQL，或者需要先看当前 schema 再决定怎么改的函数。 */
type Migration = string | ((db: Database.Database) => void)

/**
 * 迁移列表。Pigcode 还没有分发给用户，现有的表都在第一个迁移里一次建好；以后改 schema 时在后面追加，
 * 已经发出去的迁移不再改动。
 */
const MIGRATIONS: Migration[] = [
  `
  CREATE TABLE projects (
    id TEXT PRIMARY KEY,
    root_path TEXT NOT NULL UNIQUE,
    name TEXT NOT NULL,
    created_at TEXT NOT NULL,
    archived_at TEXT
  );

  CREATE TABLE threads (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL REFERENCES projects(id),
    parent_thread_id TEXT REFERENCES threads(id),
    title TEXT NOT NULL,
    default_agent_id TEXT NOT NULL,
    last_agent_id TEXT,
    last_model_id TEXT,
    permission_mode TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    archived_at TEXT,
    last_run_id TEXT
  );

  CREATE INDEX idx_threads_parent ON threads(parent_thread_id);

  CREATE TABLE runs (
    id TEXT PRIMARY KEY,
    thread_id TEXT NOT NULL REFERENCES threads(id),
    agent_session_id TEXT NOT NULL,
    status TEXT NOT NULL,
    started_at TEXT NOT NULL,
    completed_at TEXT,
    error_code TEXT,
    error_message TEXT,
    checkpoint_id TEXT
  );

  CREATE TABLE thread_events (
    seq INTEGER PRIMARY KEY AUTOINCREMENT,
    thread_id TEXT NOT NULL,
    run_id TEXT,
    type TEXT NOT NULL,
    payload_json TEXT NOT NULL,
    schema_version INTEGER NOT NULL,
    created_at TEXT NOT NULL
  );

  CREATE INDEX idx_thread_events_thread_seq ON thread_events(thread_id, seq);

  CREATE TABLE command_receipts (
    command_id TEXT PRIMARY KEY,
    result_json TEXT NOT NULL,
    created_at TEXT NOT NULL
  );

  CREATE TABLE agent_sessions (
    id TEXT PRIMARY KEY,
    thread_id TEXT NOT NULL REFERENCES threads(id),
    agent_id TEXT NOT NULL,
    native_session_id TEXT,
    cwd TEXT NOT NULL,
    status TEXT NOT NULL,
    created_at TEXT NOT NULL,
    stopped_at TEXT
  );

  CREATE TABLE pending_requests (
    id TEXT PRIMARY KEY,
    thread_id TEXT NOT NULL REFERENCES threads(id),
    run_id TEXT NOT NULL REFERENCES runs(id),
    kind TEXT NOT NULL,
    agent_request_id TEXT,
    payload_json TEXT NOT NULL,
    status TEXT NOT NULL,
    created_at TEXT NOT NULL,
    resolved_at TEXT
  );

  CREATE INDEX idx_pending_requests_thread_status ON pending_requests(thread_id, status);

  CREATE TABLE checkpoints (
    id TEXT PRIMARY KEY,
    thread_id TEXT NOT NULL REFERENCES threads(id),
    run_id TEXT,
    phase TEXT NOT NULL,
    git_ref TEXT NOT NULL,
    commit_sha TEXT,
    label TEXT,
    created_at TEXT NOT NULL
  );

  CREATE INDEX idx_checkpoints_thread_created ON checkpoints(thread_id, created_at);

  CREATE TABLE worktrees (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL REFERENCES projects(id),
    thread_id TEXT NOT NULL REFERENCES threads(id),
    path TEXT NOT NULL UNIQUE,
    branch TEXT,
    status TEXT NOT NULL,
    created_at TEXT NOT NULL,
    removed_at TEXT
  );

  -- 定时任务：rule_json 是运行规则（contracts 的 ScheduleRule）；next_run_at 为空表示过了结束日期，任务已完成。
  CREATE TABLE schedules (
    id TEXT PRIMARY KEY,
    thread_id TEXT NOT NULL REFERENCES threads(id),
    title TEXT NOT NULL,
    prompt TEXT NOT NULL,
    rule_json TEXT NOT NULL,
    ends_at TEXT,
    enabled INTEGER NOT NULL,
    next_run_at TEXT,
    last_run_at TEXT,
    last_run_id TEXT,
    run_count INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  CREATE INDEX idx_schedules_next_run ON schedules(enabled, next_run_at);

  -- 定时任务的每一次触发：source 是 schedule（到点）或 manual（立即运行）；status 是 started（启动了 run，
  -- 结果看 runs 表）、skipped（会话正忙或 Agent 不可用）或 failed（启动出错）。
  CREATE TABLE schedule_runs (
    id TEXT PRIMARY KEY,
    schedule_id TEXT NOT NULL REFERENCES schedules(id) ON DELETE CASCADE,
    source TEXT NOT NULL,
    status TEXT NOT NULL,
    run_id TEXT,
    error TEXT,
    triggered_at TEXT NOT NULL
  );

  CREATE INDEX idx_schedule_runs_schedule ON schedule_runs(schedule_id, triggered_at);
  `,
  `
  -- Agent 实例：线程与会话记下自己是哪个实例（agent 的一套独立配置）跑的。
  -- 旧数据没有值时按 agent_id 当作默认实例。
  ALTER TABLE threads ADD COLUMN default_instance_id TEXT;
  ALTER TABLE threads ADD COLUMN last_instance_id TEXT;
  ALTER TABLE agent_sessions ADD COLUMN instance_id TEXT;
  `,
]

/** 最新的 schema 版本，也就是迁移的个数。 */
export const SCHEMA_VERSION = MIGRATIONS.length

/** 数据库当前的 schema 版本。 */
export function schemaVersion(db: Database.Database): number {
  return db.pragma("user_version", { simple: true }) as number
}

/**
 * 按 user_version 执行缺失迁移，默认迁到最新。每个迁移和它的版本号在同一个事务里提交：
 * 中途退出不会留下改了一半、版本号却没变的库。
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
