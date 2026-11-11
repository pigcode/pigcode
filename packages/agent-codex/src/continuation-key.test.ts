import { homedir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { CodexDriver } from "./driver"

describe("Codex continuation key", () => {
  it("is the resolved CODEX_HOME, so instances sharing it can share threads", () => {
    const driver = new CodexDriver()
    const base = process.env.CODEX_HOME ?? join(homedir(), ".codex")
    expect(driver.continuationKey({})).toBe(`codex:${base}`)
    expect(driver.continuationKey({ homePath: "~/work-codex" })).toBe(
      `codex:${join(homedir(), "work-codex")}`,
    )
  })
})
