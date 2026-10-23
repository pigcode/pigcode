/** 验证 store 追加事件、累加 delta、去重与每线程独立状态。 */
import { describe, expect, it } from "vitest"
import type { ThreadEvent } from "@pigcode/contracts"
import { AppStore } from "./store"

/** 构造一条线程事件；seq 由调用方指定。 */
function threadEvent(
  threadId: string,
  seq: number,
  type: ThreadEvent["type"],
  payload: unknown = {},
): ThreadEvent {
  return {
    seq,
    threadId,
    runId: "run_1",
    type,
    payload,
    schemaVersion: 1,
    createdAt: "2026-10-20T00:00:00.000Z",
  }
}

describe("AppStore", () => {
  it("appends events and deduplicates by seq", () => {
    const store = new AppStore()
    store.addEvent(threadEvent("th_1", 1, "thread.created"))
    store.addEvent(threadEvent("th_1", 1, "thread.created"))
    expect(store.getSnapshot().events).toHaveLength(1)
  })

  it("accumulates streaming text", () => {
    const store = new AppStore()
    store.openThread("th_1")
    store.setActiveThread("th_1")
    store.appendDelta("th_1", "hello")
    store.appendDelta("th_1", " world")
    expect(store.getSnapshot().streamingText).toBe("hello world")
  })

  it("ignores late deltas for a closed thread", () => {
    const store = new AppStore()
    store.openThread("th_1")
    store.openThread("th_2")
    store.setActiveThread("th_2")
    store.closeThread("th_1")

    store.appendDelta("th_1", "late background text")

    expect(store.getSnapshot().streamingText).toBe("")
    expect(store.getSnapshot().threadStates["th_1"]).toBeUndefined()
  })

  it("keeps streaming text when a subagent message completes", () => {
    const store = new AppStore()
    store.openThread("th_1")
    store.setActiveThread("th_1")
    store.appendDelta("th_1", "main answer")

    store.addEvent(
      threadEvent("th_1", 1, "message.completed", {
        role: "assistant",
        text: "child answer",
        parentToolUseId: "tool_1",
      }),
    )

    expect(store.getSnapshot().threadStates["th_1"]?.streamingText).toBe("main answer")
    expect(store.getSnapshot().streamingText).toBe("main answer")
  })

  it("ends the streaming text when the run is interrupted", () => {
    const store = new AppStore()
    store.openThread("th_1")
    store.setActiveThread("th_1")

    store.addEvent(threadEvent("th_1", 1, "run.started"))
    store.appendDelta("th_1", "half an ans")
    store.addEvent(threadEvent("th_1", 2, "run.interrupted"))

    expect(store.getSnapshot().streamingText).toBe("")
    expect(store.getSnapshot().threadStates["th_1"]).toMatchObject({
      status: "interrupted",
      streamingText: "",
    })
  })

  it("does not let a late approval resolution revive a terminal run", () => {
    const store = new AppStore()
    store.openThread("th_1")
    store.setActiveThread("th_1")

    store.addEvent(threadEvent("th_1", 1, "run.started"))
    store.addEvent(threadEvent("th_1", 2, "approval.requested"))
    store.addEvent(threadEvent("th_1", 3, "run.interrupted"))
    store.addEvent(threadEvent("th_1", 4, "approval.resolved", { decision: "deny" }))

    expect(store.getSnapshot().threadStates["th_1"]).toMatchObject({
      status: "interrupted",
      pendingApprovals: 0,
    })
  })

  it("keeps events and streaming text per thread and mirrors the active one", () => {
    const store = new AppStore()
    store.openThread("th_1")
    store.openThread("th_2")
    store.setActiveThread("th_1")

    store.addEvent(threadEvent("th_1", 1, "message.completed"))
    store.addEvent(threadEvent("th_2", 1, "message.completed"))
    store.appendDelta("th_1", "one")
    store.appendDelta("th_2", "two")

    const first = store.getSnapshot()
    expect(first.threadStates["th_1"]?.events).toHaveLength(1)
    expect(first.threadStates["th_2"]?.events).toHaveLength(1)
    expect(first.events.map((event) => event.threadId)).toEqual(["th_1"])
    expect(first.streamingText).toBe("one")

    store.setActiveThread("th_2")
    const second = store.getSnapshot()
    expect(second.events.map((event) => event.threadId)).toEqual(["th_2"])
    expect(second.streamingText).toBe("two")
  })

  it("clears streaming text only for the thread that completed", () => {
    const store = new AppStore()
    store.openThread("th_1")
    store.openThread("th_2")
    store.setActiveThread("th_2")
    store.appendDelta("th_1", "background")
    store.appendDelta("th_2", "foreground")

    store.addEvent(threadEvent("th_1", 1, "message.completed"))

    const state = store.getSnapshot()
    expect(state.threadStates["th_1"]?.streamingText).toBe("")
    expect(state.threadStates["th_2"]?.streamingText).toBe("foreground")
    expect(state.streamingText).toBe("foreground")
  })

  it("derives run status and approval counts per thread", () => {
    const store = new AppStore()
    store.openThread("th_1")
    store.setActiveThread("th_1")

    store.addEvent(threadEvent("th_1", 1, "run.started"))
    expect(store.getSnapshot().threadStates["th_1"]?.status).toBe("running")

    store.addEvent(threadEvent("th_1", 2, "approval.requested"))
    expect(store.getSnapshot().threadStates["th_1"]).toMatchObject({
      status: "waiting-approval",
      pendingApprovals: 1,
    })

    store.addEvent(threadEvent("th_1", 3, "approval.resolved"))
    expect(store.getSnapshot().threadStates["th_1"]).toMatchObject({
      status: "running",
      pendingApprovals: 0,
    })

    store.addEvent(threadEvent("th_1", 4, "run.failed", { message: "boom" }))
    expect(store.getSnapshot().threadStates["th_1"]).toMatchObject({
      status: "failed",
      lastError: "boom",
    })

    store.addEvent(threadEvent("th_1", 5, "run.completed"))
    expect(store.getSnapshot().threadStates["th_1"]?.status).toBe("completed")

    store.setThreadError("th_1", "manual")
    expect(store.getSnapshot().threadStates["th_1"]?.lastError).toBe("manual")
    store.setThreadStatus("th_1", "interrupted")
    expect(store.getSnapshot().threadStates["th_1"]?.status).toBe("interrupted")
  })

  it("closes a thread and activates the next open one", () => {
    const store = new AppStore()
    store.openThread("th_1")
    store.openThread("th_2")
    store.openThread("th_3")
    store.setActiveThread("th_2")
    store.addEvent(threadEvent("th_2", 1, "message.completed"))
    store.addEvent(threadEvent("th_3", 1, "message.completed"))

    store.closeThread("th_2")

    const state = store.getSnapshot()
    expect(state.openThreadIds).toEqual(["th_1", "th_3"])
    expect(state.threadStates["th_2"]).toBeUndefined()
    expect(state.activeThreadId).toBe("th_3")
    expect(state.events.map((event) => event.threadId)).toEqual(["th_3"])

    store.closeThread("th_3")
    expect(store.getSnapshot().activeThreadId).toBe("th_1")
    expect(store.getSnapshot().events).toEqual([])
  })
})
