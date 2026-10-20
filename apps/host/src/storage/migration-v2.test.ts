/** 验证 migration 2 创建 provider_sessions 与 pending_requests。 */
import { describe, expect, it } from "vitest"
import { openDatabase } from "./database"

describe("migration v2", () => {
  it("creates provider session and pending request tables", () => {
    const db = openDatabase(":memory:")
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
