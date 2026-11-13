import Database from "better-sqlite3"
import { expect, it } from "vitest"
import { migrate, SCHEMA_VERSION } from "./migrations"

it("splits legacy planning and preserves Codex read-only restrictions", () => {
  const db = new Database(":memory:")
  migrate(db, 5)
  db.exec(
    "INSERT INTO projects(id, root_path, name, created_at) VALUES ('p', '/tmp/project', 'project', '2026-11-13')",
  )
  for (const [id, agent, mode] of [
    ["codex-plan", "codex", "plan"],
    ["claude-read", "claude", "read-only"],
    ["codex-read", "codex", "read-only"],
    ["claude-full", "claude", "danger-full-access"],
  ]) {
    db.prepare(
      `INSERT INTO threads(id, project_id, title, default_agent_id, default_instance_id, permission_mode, created_at, updated_at)
      VALUES (?, 'p', ?, ?, ?, ?, '2026-11-13', '2026-11-13')`,
    ).run(id, id, agent, agent, mode)
  }
  migrate(db, 6)
  expect(db.pragma("user_version", { simple: true })).toBe(6)
  const rows = db.prepare("SELECT id, permission_mode, plan_mode FROM threads ORDER BY id").all()
  expect(rows).toEqual([
    { id: "claude-full", permission_mode: "danger-full-access", plan_mode: 0 },
    { id: "claude-read", permission_mode: "workspace-write", plan_mode: 1 },
    { id: "codex-plan", permission_mode: "workspace-write", plan_mode: 1 },
    { id: "codex-read", permission_mode: "read-only", plan_mode: 0 },
  ])
  expect(db.prepare("SELECT COUNT(*) AS count FROM thread_agent_modes").get()).toEqual({ count: 4 })
  const events = db.prepare("SELECT payload_json FROM thread_events ORDER BY seq").all() as Array<{
    payload_json: string
  }>
  expect(events.map((event) => JSON.parse(event.payload_json))).toEqual([
    { permissionMode: "workspace-write", planMode: true },
    { permissionMode: "workspace-write", planMode: true },
  ])
  migrate(db)
  expect(db.pragma("user_version", { simple: true })).toBe(SCHEMA_VERSION)
  expect(
    db.prepare("SELECT id, permission_mode, plan_mode FROM threads ORDER BY id").all(),
  ).toEqual([
    { id: "claude-full", permission_mode: "full-access", plan_mode: 0 },
    { id: "claude-read", permission_mode: "approval-required", plan_mode: 1 },
    { id: "codex-plan", permission_mode: "auto-accept-edits", plan_mode: 1 },
    { id: "codex-read", permission_mode: "approval-required", plan_mode: 0 },
  ])
  expect(
    db.prepare("SELECT name FROM sqlite_master WHERE name = 'thread_agent_modes'").get(),
  ).toBeUndefined()
  db.close()
})
