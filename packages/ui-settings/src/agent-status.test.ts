/** 验证 Agent 状态归一：停用、加载失败、检测中、未安装、未登录、就绪的先后，以及实例自己停用。 */
import { describe, expect, it } from "vitest"
import type { AgentStatus } from "@pigcode/contracts"
import { entityMark } from "@pigcode/ui-primitives"
import { agentHeadline, instanceHeadline } from "./agent-status"

const READY: AgentStatus = {
  installed: true,
  version: "2.1.304",
  authenticated: true,
  account: "max · claude.ai",
  command: "/usr/local/bin/claude",
}

describe("agent status helpers", () => {
  it("orders disabled, failed, checking, missing, signed out and ready", () => {
    const base = { enabled: true, registered: true, error: null }
    expect(agentHeadline({ ...base, enabled: false }, READY).label).toBe("agents.status.disabled")
    expect(agentHeadline({ ...base, registered: false, error: "boom" }, READY)).toMatchObject({
      tone: "error",
      detail: "boom",
    })
    expect(agentHeadline(base, undefined).tone).toBe("checking")
    expect(
      agentHeadline(base, { installed: false, version: null, authenticated: null }).label,
    ).toBe("agents.status.notInstalled")
    expect(agentHeadline(base, { ...READY, authenticated: false }).tone).toBe("warning")
    expect(agentHeadline(base, { installed: true, version: null, authenticated: null }).tone).toBe(
      "ready",
    )
    // 实例自己停用时先说停用。
    expect(instanceHeadline(base, { enabled: false }, READY).label).toBe("agents.status.disabled")
    expect(instanceHeadline(base, { enabled: true }, READY).tone).toBe("ready")
    expect(entityMark("claude", "Claude Code").initials).toBe("CC")
    expect(entityMark("codex", "codex").initials).toBe("CO")
  })
})
