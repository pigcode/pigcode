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
    expect(db.pragma("user_version", { simple: true })).toBe(3)
    db.close()
  })
})
