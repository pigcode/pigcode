/** 固定 Claude/Codex 的 capability，防止未来静默变化。 */
import type { ProviderCapabilities } from "@pigcode/contracts"
import { describe, expect, it } from "vitest"
import { ClaudeDriver } from "./claude/driver"
import { CodexDriver } from "./codex/driver"

/** Claude Code 在 M2 的完整能力快照。 */
const claudeCapabilities: ProviderCapabilities = {
  streaming: true,
  approvals: true,
  questions: false,
  plan: true,
  resume: true,
  fork: false,
  rollback: false,
  checkpoint: false,
  subagents: true,
  mcp: true,
  images: true,
  usage: true,
  modelCatalog: true,
  nativeSessionId: true,
}

/** Codex 在 M2 的完整能力快照；未实现的特性必须保持 false。 */
const codexCapabilities: ProviderCapabilities = {
  streaming: true,
  approvals: true,
  questions: false,
  plan: true,
  resume: true,
  fork: false,
  rollback: false,
  checkpoint: false,
  subagents: false,
  mcp: false,
  images: false,
  usage: true,
  modelCatalog: true,
  nativeSessionId: true,
}

describe("provider capabilities", () => {
  it("locks the Claude capability snapshot", () => {
    expect(new ClaudeDriver().capabilities).toStrictEqual(claudeCapabilities)
  })

  it("locks the Codex capability snapshot", () => {
    expect(new CodexDriver().capabilities).toStrictEqual(codexCapabilities)
  })

  it("keeps Codex capability flags honest", () => {
    const codex = new CodexDriver().capabilities
    expect(codex.approvals).toBe(true)
    expect(codex.questions).toBe(false)
    expect(codex.fork).toBe(false)
    expect(codex.rollback).toBe(false)
    expect(codex.checkpoint).toBe(false)
    // M2 明确不提供 subagents 与 MCP 注入，能力位不得提前打开。
    expect(codex.subagents).toBe(false)
    expect(codex.mcp).toBe(false)
  })
})
