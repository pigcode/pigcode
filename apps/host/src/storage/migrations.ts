/** 管理 SQLite schema 版本；迁移只向前。 */
import type Database from "better-sqlite3"

const MIGRATIONS: string[] = [
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
]

/** 按 user_version 执行缺失迁移。 */
export function migrate(db: Database.Database): void {
  const current = db.pragma("user_version", { simple: true }) as number
  for (let version = current; version < MIGRATIONS.length; version += 1) {
    db.exec(MIGRATIONS[version]!)
    db.pragma(`user_version = ${version + 1}`)
  }
}
