import { describe, expect, it } from "vitest"
import type { AgentCliUpdateState, DesktopUpdateState } from "@pigcode/contracts"
import { cliUpdateItems, hasAppUpdate } from "./update-items"

const cli: AgentCliUpdateState = {
  instanceId: "codex",
  agentId: "codex",
  target: "shared",
  phase: "checked",
  currentVersion: "1.0.0",
  latestVersion: "2.0.0",
  available: true,
  canUpdate: true,
  command: "updater",
  reason: null,
  error: null,
  output: "",
}

describe("unified update items", () => {
  it("shows a shared CLI installation once", () => {
    expect(cliUpdateItems({ codex: cli, second: { ...cli, instanceId: "second" } })).toEqual([cli])
  })
  it("retains completed rows while open and hides the finished indicator", () => {
    const done = { ...cli, phase: "succeeded" as const, available: false, currentVersion: "2.0.0" }
    expect(cliUpdateItems({ codex: done })).toEqual([])
    expect(cliUpdateItems({ codex: done }, true)).toEqual([done])
  })
  it("keeps actionable update errors and excludes failed version checks", () => {
    const failed = { ...cli, phase: "failed" as const, available: false }
    expect(cliUpdateItems({ codex: failed })).toEqual([failed])
    expect(cliUpdateItems({ codex: { ...failed, command: null } })).toEqual([])
  })
  it("shows an app update only when a version and action are known", () => {
    const app: DesktopUpdateState = {
      autoCheck: true,
      currentVersion: "1.0.0",
      version: null,
      url: null,
      phase: "failed",
      action: null,
      progress: null,
      error: "check",
    }
    expect(hasAppUpdate(app)).toBe(false)
    expect(hasAppUpdate({ ...app, phase: "ready", version: "2.0.0", action: "restart" })).toBe(true)
  })
})
