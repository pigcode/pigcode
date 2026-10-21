/** 验证 migration 4 创建 schedules 表。 */
import { describe, expect, it } from "vitest"
import { openDatabase } from "./database"

describe("migration v4", () => {
  it("creates the schedules table", () => {
    const db = openDatabase(":memory:")
    const names = (
      db.prepare(`SELECT name FROM sqlite_master WHERE type='table'`).all() as Array<{
        name: string
      }>
    ).map((row) => row.name)
    expect(names).toContain("schedules")
    const columns = (
      db.prepare(`PRAGMA table_info(schedules)`).all() as Array<{ name: string }>
    ).map((row) => row.name)
    expect(columns).toEqual([
      "id",
      "thread_id",
      "prompt",
      "interval_seconds",
      "enabled",
      "next_run_at",
      "last_run_at",
      "last_run_id",
      "created_at",
    ])
    expect(db.pragma("user_version", { simple: true })).toBe(4)
    db.close()
  })
})
