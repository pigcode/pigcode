/** 验证 migration 2 创建 provider_sessions 与 pending_requests（v7 把前者改名为 agent_sessions）。 */
import Database from "better-sqlite3"
import { describe, expect, it } from "vitest"
import { migrate } from "./migrations"

describe("migration v2", () => {
  it("creates provider session and pending request tables", () => {
    const db = new Database(":memory:")
    migrate(db, 2)
    const tables = db
      .prepare(`SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name`)
      .all() as Array<{ name: string }>
    const names = tables.map((row) => row.name)
    expect(names).toContain("provider_sessions")
    expect(names).toContain("pending_requests")
    expect(db.pragma("user_version", { simple: true })).toBe(2)
    db.close()
  })
})
