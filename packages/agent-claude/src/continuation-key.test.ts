import { homedir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { ClaudeDriver } from "./driver"

describe("Claude continuation key", () => {
  it("is the resolved config directory, so instances sharing it can share sessions", () => {
    const driver = new ClaudeDriver({ executable: "/bin/claude" })
    const base = process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), ".claude")
    expect(driver.continuationKey({})).toBe(`claude:${base}`)
    expect(driver.continuationKey({ configDir: "~/work-claude" })).toBe(
      `claude:${join(homedir(), "work-claude")}`,
    )
    expect(driver.continuationKey({ configDir: "~/work-claude" })).not.toBe(
      driver.continuationKey({}),
    )
  })
})
