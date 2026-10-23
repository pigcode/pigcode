/** 验证 migration 5 给 projects 加上 archived_at，已有项目保持可见。 */
import Database from "better-sqlite3"
import { describe, expect, it } from "vitest"
import { openDatabase } from "./database"
import { migrate } from "./migrations"

describe("migration v5", () => {
  it("adds archived_at to projects", () => {
    const db = openDatabase(":memory:")
    const columns = (
      db.prepare(`PRAGMA table_info(projects)`).all() as Array<{ name: string }>
    ).map((row) => row.name)
    expect(columns).toEqual(["id", "root_path", "name", "created_at", "archived_at"])
    expect(db.pragma("user_version", { simple: true })).toBeGreaterThanOrEqual(5)
    db.close()
  })

  it("upgrades a version 4 database without hiding its projects", () => {
    const db = new Database(":memory:")
    db.exec(`
      CREATE TABLE projects (
        id TEXT PRIMARY KEY,
        root_path TEXT NOT NULL UNIQUE,
        name TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE TABLE threads (id TEXT PRIMARY KEY, project_id TEXT NOT NULL);
      INSERT INTO projects VALUES ('pr_1', '/tmp/pigcode-v4', 'v4', '2026-10-20T00:00:00.000Z');
    `)
    db.pragma("user_version = 4")

    migrate(db)

    expect(db.prepare(`SELECT id, archived_at FROM projects`).all()).toEqual([
      { id: "pr_1", archived_at: null },
    ])
    expect(db.pragma("user_version", { simple: true })).toBeGreaterThanOrEqual(5)
    db.close()
  })
})
