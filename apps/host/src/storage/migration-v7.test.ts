/**
 * 验证 migration 7：provider 的表和列改成 agent 的名字，数据不变，重复执行无害；
 * 已有的数据库迁移前在旁边留一份带旧版本号的备份，不覆盖以前的备份，WAL 里的数据也在备份里。
 */
import Database from "better-sqlite3"
import { mkdtemp, readdir, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { backupPathFor, openDatabase } from "./database"
import { migrate } from "./migrations"

const NOW = "2026-10-30T00:00:00.000Z"

/** 用 v6 的迁移造一个旧数据库，并写入一个线程、一个会话、一个 run 与一个待审批请求。 */
function seedV6(db: Database.Database): void {
  migrate(db, 6)
  db.exec(`
    INSERT INTO projects (id, root_path, name, created_at) VALUES ('pr_1', '/tmp/p', 'p', '${NOW}');
    INSERT INTO threads (id, project_id, title, default_provider_id, last_provider_id, last_model_id,
      permission_mode, created_at, updated_at) VALUES
      ('th_1', 'pr_1', 'T', 'claude', 'codex', 'gpt-x', 'workspace-write', '${NOW}', '${NOW}');
    INSERT INTO provider_sessions (id, thread_id, provider_id, native_session_id, cwd, status, created_at)
      VALUES ('ps_1', 'th_1', 'codex', 'native-1', '/tmp/p', 'active', '${NOW}');
    INSERT INTO runs (id, thread_id, provider_session_id, status, started_at, error_code)
      VALUES ('run_1', 'th_1', 'ps_1', 'failed', '${NOW}', 'PROVIDER_ERROR');
    INSERT INTO pending_requests (id, thread_id, run_id, kind, provider_request_id, payload_json,
      status, created_at) VALUES ('req_1', 'th_1', 'run_1', 'approval', 'native-req', '{}', 'pending', '${NOW}');
  `)
}

function columns(db: Database.Database, table: string): string[] {
  return (db.pragma(`table_info(${table})`) as Array<{ name: string }>).map((column) => column.name)
}

describe("migration v7", () => {
  it("renames the provider tables and columns and keeps the rows", () => {
    const db = new Database(":memory:")
    seedV6(db)
    migrate(db, 7)
    expect(db.pragma("user_version", { simple: true })).toBe(7)
    expect(columns(db, "threads")).toEqual(
      expect.arrayContaining(["default_agent_id", "last_agent_id"]),
    )
    expect(columns(db, "agent_sessions")).toContain("agent_id")
    expect(columns(db, "runs")).toContain("agent_session_id")
    expect(columns(db, "pending_requests")).toContain("agent_request_id")
    const schema = db.prepare(`SELECT sql FROM sqlite_master WHERE sql IS NOT NULL`).pluck().all()
    expect(schema.join("\n")).not.toMatch(/provider/)
    expect(
      db.prepare(`SELECT default_agent_id, last_agent_id FROM threads WHERE id = 'th_1'`).get(),
    ).toEqual({ default_agent_id: "claude", last_agent_id: "codex" })
    expect(db.prepare(`SELECT agent_id, native_session_id FROM agent_sessions`).get()).toEqual({
      agent_id: "codex",
      native_session_id: "native-1",
    })
    expect(db.prepare(`SELECT agent_session_id, error_code FROM runs`).get()).toEqual({
      agent_session_id: "ps_1",
      error_code: "AGENT_ERROR",
    })
    expect(db.prepare(`SELECT agent_request_id FROM pending_requests`).pluck().get()).toBe(
      "native-req",
    )
    // 外键仍然成立：会话指向的线程还在。
    expect(db.pragma("foreign_key_check")).toEqual([])
    db.close()
  })

  it("is harmless to run again", () => {
    const db = new Database(":memory:")
    seedV6(db)
    migrate(db)
    const before = db.prepare(`SELECT sql FROM sqlite_master ORDER BY name`).all()
    db.pragma("user_version = 6")
    expect(() => migrate(db)).not.toThrow()
    expect(db.prepare(`SELECT sql FROM sqlite_master ORDER BY name`).all()).toEqual(before)
    expect(db.prepare(`SELECT COUNT(*) FROM agent_sessions`).pluck().get()).toBe(1)
    db.close()
  })
})

describe("backup before migrating", () => {
  it("backs up an existing database once, with the old schema version in the name", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pigcode-backup-"))
    const path = join(dir, "pigcode.db")
    const old = new Database(path)
    old.pragma("journal_mode = WAL")
    // 关掉自动 checkpoint：最后写的行只在 -wal 文件里，备份必须照样包含它。
    old.pragma("wal_autocheckpoint = 0")
    seedV6(old)
    old.exec(`UPDATE threads SET title = 'only in the WAL' WHERE id = 'th_1'`)

    const db = openDatabase(path)
    const backup = join(dir, "pigcode.db.schema-v6.bak")
    const copy = new Database(backup, { readonly: true })
    expect(copy.pragma("user_version", { simple: true })).toBe(6)
    expect(copy.prepare(`SELECT title, default_provider_id FROM threads`).get()).toEqual({
      title: "only in the WAL",
      default_provider_id: "claude",
    })
    copy.close()
    db.close()
    old.close()

    // 已经是最新版本：不再备份。
    openDatabase(path).close()
    expect((await readdir(dir)).filter((name) => name.endsWith(".bak"))).toEqual([
      "pigcode.db.schema-v6.bak",
    ])
  })

  it("does not back up a new database", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pigcode-backup-"))
    openDatabase(join(dir, "pigcode.db")).close()
    expect((await readdir(dir)).filter((name) => name.endsWith(".bak"))).toEqual([])
  })

  it("never reuses the name of an older backup", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pigcode-backup-"))
    const path = join(dir, "pigcode.db")
    await writeFile(`${path}.schema-v6.bak`, "older backup")
    const now = new Date("2026-11-02T10:20:30.456Z")
    const second = backupPathFor(path, 6, now)
    expect(second).toBe(`${path}.schema-v6.2026-11-02T10-20-30-456Z.bak`)
    await writeFile(second, "another backup")
    expect(backupPathFor(path, 6, now)).toBe(`${path}.schema-v6.2026-11-02T10-20-30-456Z-1.bak`)
  })
})
