/** 打开数据库：新库一次建好全部表，重复打开不改动；比应用新的数据库原样拒绝。 */
import Database from "better-sqlite3"
import { mkdtemp, readFile, stat } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { openDatabase } from "./database"
import { SCHEMA_VERSION } from "./migrations"

function columns(db: Database.Database, table: string): string[] {
  return (db.pragma(`table_info(${table})`) as Array<{ name: string }>).map((column) => column.name)
}

describe("openDatabase", () => {
  it("creates the whole schema in one step, with foreign keys on", () => {
    const db = openDatabase(":memory:")
    expect(SCHEMA_VERSION).toBe(7)
    expect(db.pragma("user_version", { simple: true })).toBe(7)
    expect(db.pragma("foreign_keys", { simple: true })).toBe(1)
    const tables = db
      .prepare(`SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name`)
      .pluck()
      .all()
    expect(tables).toEqual(
      expect.arrayContaining([
        "agent_sessions",
        "checkpoints",
        "command_receipts",
        "pending_requests",
        "projects",
        "runs",
        "schedule_runs",
        "schedules",
        "thread_events",
        "threads",
        "worktrees",
      ]),
    )
    expect(columns(db, "threads")).toEqual(
      expect.arrayContaining([
        "default_agent_id",
        "default_instance_id",
        "last_agent_id",
        "last_instance_id",
        "parent_thread_id",
      ]),
    )
    expect(columns(db, "agent_sessions")).toEqual(expect.arrayContaining(["instance_id"]))
    expect(columns(db, "worktrees")).toContain("cwd")
    expect(columns(db, "schedules")).toEqual(
      expect.arrayContaining(["title", "rule_json", "ends_at", "run_count", "updated_at"]),
    )
    db.close()
  })

  it("leaves an up-to-date database alone when it is opened again", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pigcode-db-"))
    const path = join(dir, "pigcode.db")
    openDatabase(path).close()
    const db = openDatabase(path)
    expect(db.pragma("user_version", { simple: true })).toBe(SCHEMA_VERSION)
    db.close()
  })

  it("rejects a database newer than the app and leaves it untouched", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pigcode-db-"))
    const path = join(dir, "pigcode.db")
    const db = new Database(path)
    db.exec(`CREATE TABLE future (id TEXT)`)
    db.pragma(`user_version = ${SCHEMA_VERSION + 1}`)
    db.close()
    const before = await readFile(path)
    const mtime = (await stat(path)).mtimeMs

    expect(() => openDatabase(path)).toThrow(
      `database schema v${SCHEMA_VERSION + 1} is newer than this app (v${SCHEMA_VERSION})`,
    )
    expect(await readFile(path)).toEqual(before)
    expect((await stat(path)).mtimeMs).toBe(mtime)
    // 文件还能照常打开，版本和日志模式都没被改动。
    const check = new Database(path, { readonly: true })
    expect(check.pragma("user_version", { simple: true })).toBe(SCHEMA_VERSION + 1)
    expect(check.pragma("journal_mode", { simple: true })).toBe("delete")
    check.close()
  })
})
