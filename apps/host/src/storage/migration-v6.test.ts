/** 验证 migration 6 给 threads 加上 parent_thread_id，已有会话都是主会话。 */
import Database from "better-sqlite3"
import { describe, expect, it } from "vitest"
import { openDatabase } from "./database"
import { migrate } from "./migrations"

describe("migration v6", () => {
  it("adds parent_thread_id to threads", () => {
    const db = openDatabase(":memory:")
    const columns = (db.prepare(`PRAGMA table_info(threads)`).all() as Array<{ name: string }>).map(
      (row) => row.name,
    )
    expect(columns).toContain("parent_thread_id")
    expect(db.pragma("user_version", { simple: true })).toBeGreaterThanOrEqual(6)
    db.close()
  })

  it("upgrades a version 5 database and keeps existing threads top-level", () => {
    const db = new Database(":memory:")
    db.exec(`
      CREATE TABLE threads (id TEXT PRIMARY KEY, project_id TEXT NOT NULL);
      INSERT INTO threads VALUES ('th_1', 'pr_1');
    `)
    db.pragma("user_version = 5")

    migrate(db, 6)

    expect(db.prepare(`SELECT id, parent_thread_id FROM threads`).all()).toEqual([
      { id: "th_1", parent_thread_id: null },
    ])
    expect(db.pragma("user_version", { simple: true })).toBe(6)
    db.close()
  })
})
