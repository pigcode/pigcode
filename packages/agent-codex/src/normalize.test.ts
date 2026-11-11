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

  it("maps reasoning summaries and web searches", () => {
    expect(
      normalizeCodexNotification("item/reasoning/summaryTextDelta", {
        itemId: "r1",
        delta: "Checking the tests",
        summaryIndex: 0,
      }),
    ).toEqual([{ type: "reasoning.delta", text: "Checking the tests" }])
    expect(
      normalizeCodexNotification("item/completed", {
        item: { id: "r1", type: "reasoning", summary: ["Checking the tests", "Then the docs"] },
      }),
    ).toEqual([{ type: "reasoning.completed", text: "Checking the tests\n\nThen the docs" }])
    expect(
      normalizeCodexNotification("item/completed", {
        item: { id: "r2", type: "reasoning", summary: [], content: ["raw thought"] },
      }),
    ).toEqual([{ type: "reasoning.completed", text: "raw thought" }])
    expect(
      normalizeCodexNotification("item/started", {
        item: { id: "w1", type: "webSearch", query: "vitest coverage" },
      }),
    ).toEqual([
      {
        type: "tool.started",
        toolCallId: "w1",
        name: "WebSearch",
        input: { query: "vitest coverage" },
      },
    ])
    expect(
      normalizeCodexNotification("item/completed", {
        item: { id: "w1", type: "webSearch", query: "vitest coverage" },
      }),
    ).toEqual([
      { type: "tool.completed", toolCallId: "w1", name: "WebSearch", output: "", isError: false },
    ])
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
      exitCode: 0,
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
      exitCode: 1,
    })
  })

  it("maps MCP tool calls with the same mcp__server__tool names as Claude", () => {
    const item = {
      id: "m1",
      type: "mcpToolCall",
      server: "pigcode",
      tool: "browser_click",
      arguments: { ref: "e3" },
      status: "inProgress",
    }
    expect(normalizeCodexNotification("item/started", { item })).toEqual([
      {
        type: "tool.started",
        toolCallId: "m1",
        name: "mcp__pigcode__browser_click",
        input: { ref: "e3" },
      },
    ])
    const content = [{ type: "text", text: 'Clicked button "登录".' }]
    expect(
      normalizeCodexNotification("item/completed", {
        item: { ...item, status: "completed", result: { content } },
      }),
    ).toEqual([
      {
        type: "tool.completed",
        toolCallId: "m1",
        name: "mcp__pigcode__browser_click",
        output: content,
        isError: false,
      },
    ])
    expect(
      normalizeCodexNotification("item/completed", {
        item: { ...item, status: "failed", error: { message: "No element matches e3." } },
      }),
    ).toMatchObject([{ output: "No element matches e3.", isError: true }])
  })

  it("streams command output as live deltas", () => {
    expect(
      normalizeCodexNotification("item/commandExecution/outputDelta", {
        threadId: "th",
        turnId: "t1",
        itemId: "i1",
        delta: "line 1\n",
      }),
    ).toEqual([{ type: "tool.outputDelta", toolCallId: "i1", delta: "line 1\n" }])
    expect(normalizeCodexNotification("item/commandExecution/outputDelta", { delta: "x" })).toEqual(
      [],
    )
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

  it("derives the context occupancy from the last request, not the thread total", () => {
    // 2026-11-11 从 codex-cli 0.167.0 录下来的通知。
    const tokenUsage = {
      total: {
        totalTokens: 52000,
        inputTokens: 51000,
        cachedInputTokens: 9344,
        cacheWriteInputTokens: 0,
        outputTokens: 1000,
        reasoningOutputTokens: 14,
      },
      last: {
        totalTokens: 20128,
        inputTokens: 20107,
        cachedInputTokens: 9344,
        cacheWriteInputTokens: 0,
        outputTokens: 21,
        reasoningOutputTokens: 14,
      },
      modelContextWindow: 828400,
    }
    const events = normalizeCodexNotification("thread/tokenUsage/updated", {
      threadId: "t",
      turnId: "u",
      tokenUsage,
    })
    expect(events).toEqual([
      { type: "usage.updated", usage: tokenUsage },
      { type: "context.updated", usedTokens: 20128, maxTokens: 828400, autoCompactTokens: null },
    ])
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
