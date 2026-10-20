/** 验证 Codex 通知映射。 */
import { describe, expect, it } from "vitest"
import { normalizeCodexNotification } from "./normalize"

describe("normalizeCodexNotification", () => {
  it("maps agent message deltas", () => {
    const events = normalizeCodexNotification("item/agentMessage/delta", {
      threadId: "t1",
      turnId: "turn1",
      itemId: "i1",
      delta: "OK",
    })
    expect(events).toContainEqual({ type: "message.delta", text: "OK" })
  })

  it("maps completed command execution", () => {
    const events = normalizeCodexNotification("item/completed", {
      threadId: "t1",
      turnId: "turn1",
      item: {
        id: "i1",
        type: "commandExecution",
        command: "echo hi",
        aggregatedOutput: "hi",
        exitCode: 0,
        status: "completed",
      },
    })
    expect(events).toContainEqual({
      type: "tool.completed",
      toolCallId: "i1",
      name: "Bash",
      output: "hi",
      isError: false,
    })
  })

  it("maps failed command execution", () => {
    const events = normalizeCodexNotification("item/completed", {
      item: {
        id: "i2",
        type: "commandExecution",
        command: "false",
        aggregatedOutput: "",
        exitCode: 1,
        status: "failed",
      },
    })
    expect(events).toContainEqual({
      type: "tool.completed",
      toolCallId: "i2",
      name: "Bash",
      output: "",
      isError: true,
    })
  })

  it("maps started command execution and file changes", () => {
    const command = normalizeCodexNotification("item/started", {
      item: { id: "i1", type: "commandExecution", command: "echo hi" },
    })
    expect(command).toContainEqual({
      type: "tool.started",
      toolCallId: "i1",
      name: "Bash",
      input: "echo hi",
    })

    const patch = normalizeCodexNotification("item/started", {
      item: { id: "i2", type: "fileChange", changes: [{ path: "a.txt" }] },
    })
    expect(patch).toContainEqual({
      type: "tool.started",
      toolCallId: "i2",
      name: "ApplyPatch",
      input: [{ path: "a.txt" }],
    })
  })

  it("maps file change completion", () => {
    const events = normalizeCodexNotification("item/completed", {
      item: { id: "i3", type: "fileChange", changes: [{ path: "a.txt" }], status: "completed" },
    })
    expect(events).toContainEqual({
      type: "tool.completed",
      toolCallId: "i3",
      name: "ApplyPatch",
      output: [{ path: "a.txt" }],
      isError: false,
    })
  })

  it("maps completed agent messages", () => {
    const events = normalizeCodexNotification("item/completed", {
      item: { id: "i1", type: "agentMessage", text: "done" },
    })
    expect(events).toContainEqual({ type: "message.completed", text: "done" })
  })

  it("maps plan updates and token usage", () => {
    const plan = normalizeCodexNotification("turn/plan/updated", {
      explanation: "Steps",
      plan: [{ step: "write tests", status: "completed" }],
    })
    expect(plan).toContainEqual({
      type: "plan.updated",
      explanation: "Steps",
      plan: [{ step: "write tests", status: "completed" }],
    })

    const usage = normalizeCodexNotification("thread/tokenUsage/updated", {
      tokenUsage: { inputTokens: 10, outputTokens: 5 },
    })
    expect(usage).toContainEqual({
      type: "usage.updated",
      usage: { inputTokens: 10, outputTokens: 5 },
    })
  })

  it("maps turn status to run terminal events", () => {
    expect(
      normalizeCodexNotification("turn/completed", { turn: { id: "t", status: "completed" } }),
    ).toContainEqual({ type: "run.completed" })
    expect(
      normalizeCodexNotification("turn/completed", { turn: { id: "t", status: "interrupted" } }),
    ).toContainEqual({ type: "run.interrupted" })
    expect(
      normalizeCodexNotification("turn/completed", {
        turn: { id: "t", status: "failed", error: { message: "boom" } },
      }),
    ).toContainEqual({ type: "run.failed", message: "boom" })
  })

  it("maps subAgentActivity items to subagent lifecycle events", () => {
    const started = normalizeCodexNotification("item/started", {
      item: {
        id: "sa1",
        type: "subAgentActivity",
        kind: "started",
        agentThreadId: "agent-1",
        agentPath: "/root/explorer",
        model: "gpt-5",
      },
    })
    expect(started).toEqual([
      {
        type: "subagent.started",
        toolCallId: "sa1",
        name: "/root/explorer",
        model: "gpt-5",
      },
    ])

    const completed = normalizeCodexNotification("item/completed", {
      item: {
        id: "sa1",
        type: "subAgentActivity",
        kind: "completed",
        agentThreadId: "agent-1",
        agentPath: "/root/explorer",
      },
    })
    expect(completed).toEqual([
      {
        type: "subagent.completed",
        toolCallId: "sa1",
        isError: false,
        status: "completed",
      },
    ])

    const interrupted = normalizeCodexNotification("item/completed", {
      item: {
        id: "sa2",
        type: "subAgentActivity",
        kind: "interrupted",
        agentThreadId: "agent-2",
        agentPath: "/root/worker",
      },
    })
    expect(interrupted).toEqual([
      {
        type: "subagent.completed",
        toolCallId: "sa2",
        isError: false,
        status: "interrupted",
      },
    ])

    expect(
      normalizeCodexNotification("item/started", {
        item: {
          id: "sa3",
          type: "subAgentActivity",
          kind: "interacted",
          agentThreadId: "agent-3",
          agentPath: "/root/other",
        },
      }),
    ).toEqual([])
  })

  it("maps collab agent tool calls to one subagent per receiver", () => {
    const events = normalizeCodexNotification("item/started", {
      item: {
        id: "collab1",
        type: "collabAgentToolCall",
        tool: "spawnAgent",
        status: "inProgress",
        senderThreadId: "main",
        receiverThreadIds: ["agent-a", "agent-b"],
        prompt: "inspect the repo",
        model: "gpt-5",
      },
    })
    expect(events).toEqual([
      {
        type: "subagent.started",
        toolCallId: "collab1:agent-a",
        name: "spawnAgent",
        description: "inspect the repo",
        model: "gpt-5",
      },
      {
        type: "subagent.started",
        toolCallId: "collab1:agent-b",
        name: "spawnAgent",
        description: "inspect the repo",
        model: "gpt-5",
      },
    ])
  })

  it("ignores unknown methods and malformed payloads", () => {
    expect(normalizeCodexNotification("thread/started", {})).toEqual([])
    expect(normalizeCodexNotification("item/completed", null)).toEqual([])
    expect(normalizeCodexNotification("item/completed", { item: { type: "reasoning" } })).toEqual(
      [],
    )
  })
})
