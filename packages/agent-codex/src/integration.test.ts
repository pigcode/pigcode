/** 用 JSONL fixture 回放 app-server，验证 Codex turn 的完整链路。 */
import type { AgentEvent } from "@pigcode/contracts"
import { describe, expect, it } from "vitest"
import type { ApprovalRequest, AgentRuntime } from "@pigcode/plugin-sdk"
import { CodexDriver } from "./driver"
import { replayTransport } from "./replay"

/** 构造直连 driver 的 runtime，并收集事件与审批请求。 */
function runtimeFor(options: {
  events: AgentEvent[]
  approvals?: ApprovalRequest[]
  onApproval?: (request: ApprovalRequest) => "allow-once" | "allow-for-session" | "deny"
}): AgentRuntime {
  return {
    signal: new AbortController().signal,
    emit: (event) => options.events.push(event),
    requestApproval: async (request) => {
      options.approvals?.push(request)
      return options.onApproval?.(request) ?? "allow-once"
    },
  }
}

/** 从 transport 发送内容中取出指定 id 的响应帧。 */
function responseFor(sent: string[], id: string): Record<string, unknown> | undefined {
  for (const line of sent) {
    const value: unknown = JSON.parse(line)
    if (typeof value !== "object" || value === null) continue
    const record = value as Record<string, unknown>
    if (record.id === id) return record
  }
  return undefined
}

describe("codex replay integration", () => {
  it("replays a codex turn end to end", async () => {
    const events: AgentEvent[] = []
    const driver = new CodexDriver({
      transportFactory: () => replayTransport("fixtures/simple.jsonl"),
    })
    const session = await driver.createSession({
      threadId: "t1",
      cwd: "/tmp",
      permissionMode: "workspace-write",
    })

    await driver.send(session, { text: "hello" }, runtimeFor({ events }))

    expect(session.nativeSessionId).toBe("th_native")
    expect(events.map((event) => event.type)).toContain("message.delta")
    expect(events).toContainEqual({ type: "message.delta", text: "OK" })
    expect(events).toContainEqual({ type: "message.completed", text: "OK" })
    expect(events).toContainEqual({
      type: "tool.completed",
      toolCallId: "item_patch",
      name: "ApplyPatch",
      output: [{ path: "a.txt", kind: "add" }],
      isError: false,
    })
    expect(events.at(-1)).toEqual({ type: "run.completed" })

    await driver.dispose(session)
  })

  it("replays an approval request and answers with accept", async () => {
    const events: AgentEvent[] = []
    const approvals: ApprovalRequest[] = []
    const transport = replayTransport("fixtures/approval.jsonl")
    const driver = new CodexDriver({ transportFactory: () => transport })
    const session = await driver.createSession({ threadId: "t2", cwd: "/tmp" })

    await driver.send(session, { text: "run" }, runtimeFor({ events, approvals }))

    expect(approvals).toHaveLength(1)
    expect(approvals[0]).toMatchObject({ toolName: "Bash" })
    expect(responseFor(transport.sent, "srv_1")?.result).toEqual({ decision: "accept" })
    expect(events).toContainEqual({
      type: "tool.completed",
      toolCallId: "item_cmd",
      name: "Bash",
      output: "hi",
      isError: false,
      exitCode: 0,
    })
    expect(events).toContainEqual({ type: "message.completed", text: "done" })
    expect(events.at(-1)).toEqual({ type: "run.completed" })

    await driver.dispose(session)
  })
})
