import Database from "better-sqlite3"
import { expect, it } from "vitest"
import { migrate } from "./migrations"

it("counts existing threads as read and moves their update time to the latest run", () => {
  const db = new Database(":memory:")
  migrate(db, 9)
  db.exec(`
    INSERT INTO projects(id, root_path, name, created_at)
      VALUES ('p', '/tmp/project', 'project', '2026-10-01T00:00:00.000Z');
    INSERT INTO threads(id, project_id, title, default_agent_id, permission_mode, created_at, updated_at)
      VALUES ('ran', 'p', 'ran', 'fake', 'workspace-write', '2026-10-01T00:00:00.000Z', '2026-10-02T00:00:00.000Z'),
             ('idle', 'p', 'idle', 'fake', 'workspace-write', '2026-10-01T00:00:00.000Z', '2026-10-02T00:00:00.000Z');
    INSERT INTO runs(id, thread_id, agent_session_id, status, started_at, completed_at)
      VALUES ('run_1', 'ran', 's', 'completed', '2026-11-01T00:00:00.000Z', '2026-11-01T00:05:00.000Z'),
             ('run_2', 'ran', 's', 'completed', '2026-11-03T00:00:00.000Z', '2026-11-03T00:05:00.000Z');
    INSERT INTO thread_events(thread_id, run_id, type, payload_json, schema_version, created_at)
      VALUES ('ran', 'run_2', 'run.started', '{}', 1, '2026-11-03T00:00:00.000Z'),
             ('ran', 'run_2', 'run.completed', '{}', 1, '2026-11-03T00:05:00.000Z'),
             ('ran', 'run_2', 'notice', '{}', 1, '2026-11-04T00:00:00.000Z');
  `)
  migrate(db)
  const rows = db
    .prepare("SELECT id, updated_at, last_run_id, read_at FROM threads ORDER BY id")
    .all() as Array<{ id: string; updated_at: string; last_run_id: string | null; read_at: string }>
  expect(
    rows.map(({ read_at: readAt, ...row }) => ({ ...row, read: readAt > row.updated_at })),
  ).toEqual([
    { id: "idle", updated_at: "2026-10-02T00:00:00.000Z", last_run_id: null, read: true },
    { id: "ran", updated_at: "2026-11-03T00:05:00.000Z", last_run_id: "run_2", read: true },
  ])
})
