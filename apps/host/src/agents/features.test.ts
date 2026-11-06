/** 固定 Claude/Codex 的 Agent 功能，防止未来静默变化。 */
import type { AgentFeatures } from "@pigcode/contracts"
import { describe, expect, it } from "vitest"
import { ClaudeDriver } from "@pigcode/agent-claude/driver"
import { CodexDriver } from "@pigcode/agent-codex/driver"

/** Claude Code 的完整 Agent 功能快照；AskUserQuestion 由提问卡片作答。 */
const claudeFeatures: AgentFeatures = {
  streaming: true,
  approvals: true,
  questions: true,
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

/** Codex 的完整 Agent 功能快照；未实现的特性必须保持 false，实现了的必须是 true。 */
const codexFeatures: AgentFeatures = {
  streaming: true,
  approvals: true,
  questions: false,
  plan: true,
  resume: true,
  fork: true,
  rollback: false,
  checkpoint: false,
  subagents: false,
  mcp: true,
  images: false,
  usage: true,
  modelCatalog: true,
  nativeSessionId: true,
}

describe("agent features", () => {
  it("locks the Claude feature snapshot", () => {
    expect(new ClaudeDriver().features).toStrictEqual(claudeFeatures)
  })

  it("locks the Codex feature snapshot", () => {
    expect(new CodexDriver().features).toStrictEqual(codexFeatures)
  })

  it("keeps Codex feature flags honest", () => {
    const codex = new CodexDriver().features
    expect(codex.approvals).toBe(true)
    expect(codex.questions).toBe(false)
    // app-server 的 thread/fork 已经实现（driver.test.ts 有回放用例），
    // Host 切模型时也在用，所以这里必须是 true。
    expect(codex.fork).toBe(true)
    expect(codex.rollback).toBe(false)
    expect(codex.checkpoint).toBe(false)
    // M5 起 Codex 通过 config.mcp_servers 注入插件工具；subagents 仍未实现。
    expect(codex.subagents).toBe(false)
    expect(codex.mcp).toBe(true)
  })
})
