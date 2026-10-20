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

  it("ignores unknown methods and malformed payloads", () => {
    expect(normalizeCodexNotification("thread/started", {})).toEqual([])
    expect(normalizeCodexNotification("item/completed", null)).toEqual([])
    expect(normalizeCodexNotification("item/completed", { item: { type: "reasoning" } })).toEqual(
      [],
    )
  })
})
