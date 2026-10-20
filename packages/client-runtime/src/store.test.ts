/** 验证 store 追加事件、累加 delta 与去重。 */
import { describe, expect, it } from "vitest"
import { AppStore } from "./store"

describe("AppStore", () => {
  it("appends events and deduplicates by seq", () => {
    const store = new AppStore()
    store.addEvent({
      seq: 1,
      threadId: "th_1",
      runId: null,
      type: "thread.created",
      payload: {},
      schemaVersion: 1,
      createdAt: "2026-10-20T00:00:00.000Z",
    })
    store.addEvent({
      seq: 1,
      threadId: "th_1",
      runId: null,
      type: "thread.created",
      payload: {},
      schemaVersion: 1,
      createdAt: "2026-10-20T00:00:00.000Z",
    })
    expect(store.getSnapshot().events).toHaveLength(1)
  })

  it("accumulates streaming text", () => {
    const store = new AppStore()
    store.appendDelta("run_1", "hello")
    store.appendDelta("run_1", " world")
    expect(store.getSnapshot().streamingText).toBe("hello world")
  })
})
