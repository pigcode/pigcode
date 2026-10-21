/** 验证 migration 3 创建 checkpoints 与 worktrees。 */
import { describe, expect, it } from "vitest"
import { openDatabase } from "./database"

describe("migration v3", () => {
  it("creates checkpoint and worktree tables", () => {
    const db = openDatabase(":memory:")
    const names = (
      db.prepare(`SELECT name FROM sqlite_master WHERE type='table'`).all() as Array<{ name: string }>
    ).map((row) => row.name)
    expect(names).toContain("checkpoints")
    expect(names).toContain("worktrees")
    // 后续迁移会把版本继续推高；这里只验证 v3 已应用。
    expect(db.pragma("user_version", { simple: true })).toBeGreaterThanOrEqual(3)
    db.close()
  })
})
