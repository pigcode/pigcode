import { migrateRuntimeModes } from "./runtime-mode-migration"
/** 管理 SQLite schema 版本；迁移只向前。 */
import type Database from "better-sqlite3"
import { backfillThreadItems } from "./thread-items"

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
  (db) => {
    // 会话条目与交接记录（pigcode/monorepo#77）。条目从事件日志投影出来，这里一次回填已有会话。
    db.exec(`
      CREATE TABLE thread_items (
        id TEXT PRIMARY KEY,
        thread_id TEXT NOT NULL,
        position INTEGER NOT NULL,
        kind TEXT NOT NULL,
        run_id TEXT,
        agent_id TEXT,
        instance_id TEXT,
        agent_session_id TEXT,
        parent_tool_use_id TEXT,
        status TEXT NOT NULL,
        text TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        updated_seq INTEGER NOT NULL
      );
      CREATE INDEX idx_thread_items_position ON thread_items(thread_id, position);

      CREATE TABLE thread_handoffs (
        id TEXT PRIMARY KEY,
        thread_id TEXT NOT NULL,
        strategy TEXT NOT NULL,
        from_instance_ids TEXT NOT NULL DEFAULT '[]',
        to_instance_id TEXT,
        covered_from INTEGER,
        covered_to INTEGER,
        selected_item_ids TEXT NOT NULL DEFAULT '[]',
        omitted_count INTEGER NOT NULL DEFAULT 0,
        text TEXT NOT NULL,
        delivery TEXT NOT NULL,
        target_run_id TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX idx_thread_handoffs_thread ON thread_handoffs(thread_id, delivery);
    `)
    backfillThreadItems(db)
    carryOverPendingHandoffs(db)
  },
  (db) => {
    // 工具调用条目的 id 改成按 run 区分（同一个调用 id 可能在不同轮里重复），重新从事件日志生成一遍。
    db.exec(`DELETE FROM thread_items`)
    backfillThreadItems(db)
  },
  `ALTER TABLE worktrees ADD COLUMN cwd TEXT`,
  `ALTER TABLE threads ADD COLUMN plan_mode INTEGER NOT NULL DEFAULT 0;
   INSERT INTO thread_events (thread_id, run_id, type, payload_json, schema_version, created_at)
     SELECT id, NULL, 'thread.updated', json_object('permissionMode', 'workspace-write', 'planMode', json('true')),
       1, strftime('%Y-%m-%dT%H:%M:%fZ', 'now') FROM threads
       WHERE permission_mode = 'plan'
         OR (permission_mode = 'read-only' AND COALESCE(last_agent_id, default_agent_id) = 'claude');
   UPDATE threads SET plan_mode = 1, permission_mode = 'workspace-write'
     WHERE permission_mode = 'plan'
       OR (permission_mode = 'read-only' AND COALESCE(last_agent_id, default_agent_id) = 'claude');
   CREATE TABLE thread_agent_modes (
     thread_id TEXT NOT NULL REFERENCES threads(id),
     instance_id TEXT NOT NULL,
     permission_mode TEXT NOT NULL,
     plan_mode INTEGER NOT NULL DEFAULT 0,
     PRIMARY KEY (thread_id, instance_id)
   );
   INSERT INTO thread_agent_modes (thread_id, instance_id, permission_mode, plan_mode)
     SELECT id, COALESCE(last_instance_id, default_instance_id, last_agent_id, default_agent_id),
       permission_mode, plan_mode FROM threads;`,
  migrateRuntimeModes,
]

/**
 * 以前交接写在 thread.updated 的 handoff 字段里，后面没有 run.started 就算还没发。
 * 升级时把这样还没发的交接搬进 thread_handoffs，免得升级后第一条消息丢了交接。
 */
function carryOverPendingHandoffs(db: Database.Database): void {
  const rows = db
    .prepare(
      `SELECT seq, thread_id, type, payload_json, created_at FROM thread_events
       WHERE type IN ('thread.updated', 'run.started') ORDER BY seq ASC`,
    )
    .all() as Array<{
    seq: number
    thread_id: string
    type: string
    payload_json: string
    created_at: string
  }>
  const pending = new Map<string, { text: string; subagent: boolean; createdAt: string }>()
  for (const row of rows) {
    const payload = JSON.parse(row.payload_json) as Record<string, unknown>
    if (row.type === "run.started") {
      if (payload.handoffDeferred !== true) pending.delete(row.thread_id)
      continue
    }
    if (typeof payload.handoff === "string" && payload.handoff.length > 0) {
      pending.set(row.thread_id, {
        text: payload.handoff,
        subagent: !payload.agentId,
        createdAt: row.created_at,
      })
    }
  }
  const insert = db.prepare(
    `INSERT INTO thread_handoffs (id, thread_id, strategy, text, delivery, created_at, updated_at)
     VALUES (?, ?, ?, ?, 'pending', ?, ?)`,
  )
  for (const [threadId, handoff] of pending) {
    insert.run(
      `ho_legacy_${threadId}`,
      threadId,
      handoff.subagent ? "subagent_brief" : "switch",
      handoff.text,
      handoff.createdAt,
      handoff.createdAt,
    )
  }
}

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
