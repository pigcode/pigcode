/** 用 fixture 与内存消息验证 SDK 消息到规范化事件的映射。 */
import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"
import { createNormalizeState, normalizeSdkMessage } from "./normalize"

describe("normalizeSdkMessage", () => {
  it("maps text deltas", () => {
    const state = createNormalizeState()
    const events = normalizeSdkMessage(
      {
        type: "stream_event",
        event: { type: "content_block_delta", delta: { type: "text_delta", text: "OK" } },
        session_id: "s1",
        uuid: "u1",
      } as never,
      state,
    )
    expect(events).toContainEqual({ type: "message.delta", text: "OK" })
    expect(state.streamedText).toBe("OK")
  })

  it("maps assistant tool_use to tool.started", () => {
    const state = createNormalizeState()
    const events = normalizeSdkMessage(
      {
        type: "assistant",
        message: {
          content: [
            { type: "tool_use", id: "tool_1", name: "Read", input: { file_path: "/tmp/a.ts" } },
          ],
        },
        session_id: "s1",
        uuid: "u1",
      } as never,
      state,
    )
    expect(events).toEqual([
      {
        type: "tool.started",
        toolCallId: "tool_1",
        name: "Read",
        input: { file_path: "/tmp/a.ts" },
      },
    ])
  })

  it("maps user tool_result to tool.completed with the original tool name", () => {
    const state = createNormalizeState()
    normalizeSdkMessage(
      {
        type: "assistant",
        message: {
          content: [
            { type: "tool_use", id: "tool_1", name: "Read", input: { file_path: "/tmp/a.ts" } },
          ],
        },
        session_id: "s1",
        uuid: "u1",
      } as never,
      state,
    )
    const events = normalizeSdkMessage(
      {
        type: "user",
        message: {
          content: [
            { type: "tool_result", tool_use_id: "tool_1", content: "file body", is_error: false },
          ],
        },
        session_id: "s1",
        uuid: "u2",
      } as never,
      state,
    )
    expect(events).toEqual([
      {
        type: "tool.completed",
        toolCallId: "tool_1",
        name: "Read",
        output: "file body",
        isError: false,
      },
    ])
  })

  it("emits usage.updated and run.completed for a successful result", () => {
    const events = normalizeSdkMessage(
      {
        type: "result",
        subtype: "success",
        is_error: false,
        result: "done",
        session_id: "s1",
        uuid: "u1",
        total_cost_usd: 0.0123,
        modelUsage: { "claude-sonnet": { inputTokens: 10, outputTokens: 5 } },
      } as never,
      createNormalizeState(),
    )
    expect(events).toContainEqual({
      type: "usage.updated",
      usage: {
        modelUsage: { "claude-sonnet": { inputTokens: 10, outputTokens: 5 } },
        totalCostUsd: 0.0123,
      },
    })
    expect(events).toContainEqual({ type: "message.completed", text: "done" })
    expect(events).toContainEqual({ type: "run.completed" })
  })

  it("emits run.failed for an error result", () => {
    const events = normalizeSdkMessage(
      {
        type: "result",
        subtype: "error_during_execution",
        is_error: true,
        session_id: "s1",
        uuid: "u1",
      } as never,
      createNormalizeState(),
    )
    expect(events).toEqual([{ type: "run.failed", message: "error_during_execution" }])
  })

  it("normalizes the simple replay fixture in order", () => {
    const path = fileURLToPath(new URL("./fixtures/simple.jsonl", import.meta.url))
    const lines = readFileSync(path, "utf8")
      .split("\n")
      .filter((line) => line.trim().length > 0)
    const state = createNormalizeState()
    const events = lines.flatMap((line) => normalizeSdkMessage(JSON.parse(line) as never, state))
    expect(events.map((event) => event.type)).toEqual([
      "session.started",
      "message.delta",
      "tool.started",
      "tool.completed",
      "message.completed",
      "usage.updated",
      "run.completed",
    ])
    expect(state.streamedText).toBe("OK")
  })
})
