/** 验证思考过程的映射：增量只走实时通道，落成事件时带上持续时长。 */
import { afterEach, describe, expect, it, vi } from "vitest"
import type { AgentEvent } from "@pigcode/contracts"
import { mapAgentEvent, type RunEventHooks } from "./run-events"
import type { ActiveRun } from "./run-queue"

function harness() {
  const live: AgentEvent[] = []
  const appended: Array<{ type: string; payload: unknown }> = []
  const run = {
    runId: "run_1",
    threadId: "th_1",
    emitLive: (event: AgentEvent) => live.push(event),
    liveText: "",
  } as unknown as ActiveRun
  const hooks: RunEventHooks = {
    isActive: () => true,
    append: (_threadId, _runId, type, payload) => appended.push({ type, payload }),
    updateNativeSessionId: () => undefined,
    finish: () => undefined,
  }
  return { run, hooks, live, appended }
}

afterEach(() => {
  vi.useRealTimers()
})

describe("mapAgentEvent notices", () => {
  it("persists a notice with its level, key and params", () => {
    const { run, hooks, live, appended } = harness()
    mapAgentEvent(
      run,
      { type: "notice", level: "warning", key: "mcp.bridge.failed", params: { name: "pigcode" } },
      hooks,
    )
    expect(appended).toEqual([
      {
        type: "notice",
        payload: { level: "warning", key: "mcp.bridge.failed", params: { name: "pigcode" } },
      },
    ])
    // 提示不是流式事件，不进实时通道。
    expect(live).toEqual([])
  })
})

describe("mapAgentEvent reasoning", () => {
  it("streams thinking live and records how long it took", () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date("2026-10-22T08:00:00.000Z"))
    const { run, hooks, live, appended } = harness()
    mapAgentEvent(run, { type: "reasoning.delta", text: "Read the " }, hooks)
    vi.setSystemTime(new Date("2026-10-22T08:00:04.200Z"))
    mapAgentEvent(run, { type: "reasoning.delta", text: "tests" }, hooks)
    mapAgentEvent(run, { type: "reasoning.completed", text: "Read the tests" }, hooks)

    expect(live.map((event) => event.type)).toEqual(["reasoning.delta", "reasoning.delta"])
    expect(appended).toEqual([
      { type: "reasoning.completed", payload: { text: "Read the tests", durationMs: 4200 } },
    ])
    expect(run.reasoningStartedAt).toBeUndefined()
  })

  it("keeps sub-agent thinking out of the live channel and skips empty thoughts", () => {
    const { run, hooks, live, appended } = harness()
    mapAgentEvent(run, { type: "reasoning.delta", text: "x", parentToolUseId: "task_1" }, hooks)
    mapAgentEvent(
      run,
      { type: "reasoning.completed", text: "child thought", parentToolUseId: "task_1" },
      hooks,
    )
    mapAgentEvent(run, { type: "reasoning.completed", text: "   " }, hooks)
    expect(live).toEqual([])
    expect(appended).toEqual([
      {
        type: "reasoning.completed",
        payload: { text: "child thought", parentToolUseId: "task_1" },
      },
    ])
  })
})
