/** 用 replay query 驱动 driver，验证事件顺序与审批。 */
import type { Options } from "@anthropic-ai/claude-agent-sdk"
import { describe, expect, it } from "vitest"
import { ClaudeDriver } from "./driver"
import { replayQuery } from "./replay"

describe("ClaudeDriver", () => {
  it("emits deltas, tool events, usage, and completion", async () => {
    const events: string[] = []
    const driver = new ClaudeDriver({ queryFn: replayQuery("fixtures/simple.jsonl") })
    const session = await driver.createSession({ threadId: "t1", cwd: "/tmp" })
    await driver.send(
      session,
      { text: "hello" },
      {
        signal: new AbortController().signal,
        emit: (event) => events.push(event.type),
        requestApproval: async () => "allow-once",
      },
    )
    expect(events).toContain("message.delta")
    expect(events).toContain("message.completed")
    expect(events).toContain("usage.updated")
    expect(events).toContain("run.completed")
  })

  it("replays tool use and tool result in order", async () => {
    const events: string[] = []
    let approvalCalls = 0
    const driver = new ClaudeDriver({ queryFn: replayQuery("fixtures/tool-approval.jsonl") })
    const session = await driver.createSession({ threadId: "t2", cwd: "/tmp" })
    await driver.send(
      session,
      { text: "run a command" },
      {
        signal: new AbortController().signal,
        emit: (event) => events.push(event.type),
        requestApproval: async () => {
          approvalCalls += 1
          return "allow-once"
        },
      },
    )
    expect(events).toContain("tool.started")
    expect(events).toContain("tool.completed")
    expect(events).toContain("run.completed")
    expect(events.indexOf("tool.started")).toBeLessThan(events.indexOf("tool.completed"))
    // replay 不经过 SDK 的 canUseTool，审批回调不会触发。
    expect(approvalCalls).toBe(0)
  })

  it("passes dontAsk permission mode through to the SDK", async () => {
    let captured: Options | undefined
    const replay = replayQuery("fixtures/simple.jsonl")
    const driver = new ClaudeDriver({
      queryFn: (params) => {
        captured = params.options
        return replay(params)
      },
    })
    const session = await driver.createSession({
      threadId: "t3",
      cwd: "/tmp",
      permissionMode: "dontAsk",
    })
    await driver.send(
      session,
      { text: "hello" },
      {
        signal: new AbortController().signal,
        emit: () => undefined,
        requestApproval: async () => "allow-once",
      },
    )
    // 真实冒烟依赖 dontAsk：不弹权限提示，未预授权的工具直接拒绝。
    expect(captured?.permissionMode).toBe("dontAsk")
  })
})
