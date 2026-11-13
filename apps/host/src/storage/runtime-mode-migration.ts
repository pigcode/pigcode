import type Database from "better-sqlite3"
import { normalizeRuntimeMode } from "@pigcode/contracts"

/** 将旧的 Agent 专属 id 转成统一档位；事件也记录迁移，历史回放不会覆盖新状态。 */
export function migrateRuntimeModes(db: Database.Database): void {
  const rows = db
    .prepare(
      "SELECT id, COALESCE(last_agent_id, default_agent_id) AS agent, permission_mode, plan_mode FROM threads",
    )
    .all() as Array<{
    id: string
    agent: string
    permission_mode: string
    plan_mode: number
  }>
  for (const row of rows) {
    const mode = normalizeRuntimeMode(row.permission_mode, row.agent)
    if (!mode || mode === row.permission_mode) continue
    db.prepare("UPDATE threads SET permission_mode = ? WHERE id = ?").run(mode, row.id)
    db.prepare(
      `INSERT INTO thread_events(thread_id, run_id, type, payload_json, schema_version, created_at)
      VALUES (?, NULL, 'thread.updated', ?, 1, ?)`,
    ).run(
      row.id,
      JSON.stringify({ permissionMode: mode, planMode: row.plan_mode === 1 }),
      new Date().toISOString(),
    )
  }
  db.exec("DROP TABLE thread_agent_modes")
}
