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

  it("maps thinking to reasoning and keeps the narration between tools", () => {
    const state = createNormalizeState()
    const delta = normalizeSdkMessage(
      {
        type: "stream_event",
        event: {
          type: "content_block_delta",
          delta: { type: "thinking_delta", thinking: "Let me look" },
        },
        session_id: "s1",
        uuid: "u0",
      } as never,
      state,
    )
    expect(delta).toEqual([{ type: "reasoning.delta", text: "Let me look" }])

    const assistant = (uuid: string, content: unknown[]) =>
      normalizeSdkMessage(
        { type: "assistant", message: { content }, session_id: "s1", uuid } as never,
        state,
      )
    expect(
      assistant("u1", [
        { type: "thinking", thinking: "Read the entry file first.", signature: "sig" },
        { type: "text", text: "I'll read the file." },
        { type: "tool_use", id: "tool_1", name: "Read", input: { file_path: "a.ts" } },
      ]),
    ).toEqual([
      { type: "reasoning.completed", text: "Read the entry file first." },
      { type: "message.completed", text: "I'll read the file." },
      { type: "tool.started", toolCallId: "tool_1", name: "Read", input: { file_path: "a.ts" } },
    ])
    expect(assistant("u2", [{ type: "text", text: "All done." }])).toEqual([
      { type: "message.completed", text: "All done." },
    ])

    // result 只是重复最后一段回答，不能再写一遍。
    const result = normalizeSdkMessage(
      {
        type: "result",
        subtype: "success",
        is_error: false,
        result: "All done.",
        session_id: "s1",
        uuid: "u3",
        total_cost_usd: 0,
        modelUsage: {},
      } as never,
      state,
    )
    expect(result.map((event) => event.type)).toEqual(["usage.updated", "run.completed"])
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

  it("maps Task tool use and result to subagent lifecycle events", () => {
    const state = createNormalizeState()
    const started = normalizeSdkMessage(
      {
        type: "assistant",
        message: {
          content: [
            {
              type: "tool_use",
              id: "task_1",
              name: "Task",
              input: {
                description: "Explore the repo",
                prompt: "List the entry points and how they are wired.",
                subagent_type: "Explore",
                model: "haiku",
              },
            },
          ],
        },
        parent_tool_use_id: null,
        session_id: "s1",
        uuid: "u1",
      } as never,
      state,
    )
    expect(started).toEqual([
      {
        type: "subagent.started",
        toolCallId: "task_1",
        name: "Explore",
        description: "Explore the repo",
        prompt: "List the entry points and how they are wired.",
        model: "haiku",
      },
    ])

    const completed = normalizeSdkMessage(
      {
        type: "user",
        message: {
          content: [
            {
              type: "tool_result",
              tool_use_id: "task_1",
              content: "report body",
              is_error: false,
            },
          ],
        },
        parent_tool_use_id: null,
        session_id: "s1",
        uuid: "u2",
      } as never,
      state,
    )
    expect(completed).toEqual([
      {
        type: "subagent.completed",
        toolCallId: "task_1",
        output: "report body",
        isError: false,
        status: "completed",
      },
    ])
  })

  it("treats Agent tool use as a subagent as well", () => {
    const events = normalizeSdkMessage(
      {
        type: "assistant",
        message: {
          content: [{ type: "tool_use", id: "agent_1", name: "Agent", input: {} }],
        },
        parent_tool_use_id: null,
        session_id: "s1",
        uuid: "u1",
      } as never,
      createNormalizeState(),
    )
    expect(events).toContainEqual({
      type: "subagent.started",
      toolCallId: "agent_1",
      name: "Agent",
    })
  })

  it("tags subagent messages and tools with parentToolUseId", () => {
    const state = createNormalizeState()
    normalizeSdkMessage(
      {
        type: "assistant",
        message: {
          content: [{ type: "tool_use", id: "task_1", name: "Task", input: {} }],
        },
        parent_tool_use_id: null,
        session_id: "s1",
        uuid: "u1",
      } as never,
      state,
    )

    const delta = normalizeSdkMessage(
      {
        type: "stream_event",
        event: { type: "content_block_delta", delta: { type: "text_delta", text: "working" } },
        parent_tool_use_id: "task_1",
        session_id: "s1",
        uuid: "u2",
      } as never,
      state,
    )
    expect(delta).toEqual([{ type: "message.delta", text: "working", parentToolUseId: "task_1" }])

    const text = normalizeSdkMessage(
      {
        type: "assistant",
        message: { content: [{ type: "text", text: "Found it" }] },
        parent_tool_use_id: "task_1",
        session_id: "s1",
        uuid: "u3",
      } as never,
      state,
    )
    expect(text).toEqual([
      { type: "message.completed", text: "Found it", parentToolUseId: "task_1" },
    ])

    const tool = normalizeSdkMessage(
      {
        type: "assistant",
        message: {
          content: [{ type: "tool_use", id: "read_1", name: "Read", input: { file_path: "a.ts" } }],
        },
        parent_tool_use_id: "task_1",
        session_id: "s1",
        uuid: "u4",
      } as never,
      state,
    )
    expect(tool).toEqual([
      {
        type: "tool.started",
        toolCallId: "read_1",
        name: "Read",
        input: { file_path: "a.ts" },
        parentToolUseId: "task_1",
      },
    ])

    const result = normalizeSdkMessage(
      {
        type: "user",
        message: {
          content: [
            {
              type: "tool_result",
              tool_use_id: "read_1",
              content: "body",
              is_error: true,
            },
          ],
        },
        parent_tool_use_id: "task_1",
        session_id: "s1",
        uuid: "u5",
      } as never,
      state,
    )
    expect(result).toEqual([
      {
        type: "tool.completed",
        toolCallId: "read_1",
        name: "Read",
        output: "body",
        isError: true,
        parentToolUseId: "task_1",
      },
    ])
  })

  it("emits run.completed only once when a subagent finishes first", () => {
    const state = createNormalizeState()
    normalizeSdkMessage(
      {
        type: "assistant",
        message: {
          content: [{ type: "tool_use", id: "task_1", name: "Task", input: {} }],
        },
        parent_tool_use_id: null,
        session_id: "s1",
        uuid: "u1",
      } as never,
      state,
    )
    normalizeSdkMessage(
      {
        type: "user",
        message: {
          content: [{ type: "tool_result", tool_use_id: "task_1", content: "ok", is_error: false }],
        },
        parent_tool_use_id: null,
        session_id: "s1",
        uuid: "u2",
      } as never,
      state,
    )
    const events = normalizeSdkMessage(
      {
        type: "result",
        subtype: "success",
        is_error: false,
        result: "done",
        session_id: "s1",
        uuid: "u3",
        total_cost_usd: 0,
        modelUsage: {},
      } as never,
      state,
    )
    expect(events.filter((event) => event.type === "run.completed")).toHaveLength(1)
    expect(events).toContainEqual({ type: "message.completed", text: "done" })
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
      "message.completed",
      "usage.updated",
      "run.completed",
    ])
    expect(state.streamedText).toBe("OK")
  })
})
