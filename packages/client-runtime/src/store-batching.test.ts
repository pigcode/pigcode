/** 验证 store 的批量写入：整段回放只通知一次、按帧合并流式文本，以及 thread.updated 同步线程字段。 */
import { describe, expect, it } from "vitest"
import type { Thread, ThreadEvent } from "@pigcode/contracts"
import { AppStore } from "./store"

function threadEvent(
  threadId: string,
  seq: number,
  type: ThreadEvent["type"],
  payload: unknown = {},
  runId: string | null = "run_1",
): ThreadEvent {
  return {
    seq,
    threadId,
    runId,
    type,
    payload,
    schemaVersion: 1,
    createdAt: "2026-10-21T00:00:00.000Z",
  }
}

/** 手动推进的调度器：flush() 时才执行排队的回调。 */
function manualSchedule(): { schedule: (callback: () => void) => void; flush: () => void } {
  const queue: Array<() => void> = []
  return {
    schedule: (callback) => queue.push(callback),
    flush: () => {
      for (const callback of queue.splice(0)) callback()
    },
  }
}

const thread: Thread = {
  id: "th_1",
  projectId: "p1",
  title: "Old",
  defaultAgentId: "claude",
  defaultInstanceId: null,
  lastAgentId: null,
  lastInstanceId: null,
  lastModelId: null,
  permissionMode: "workspace-write",
  createdAt: "2026-10-21T00:00:00.000Z",
  updatedAt: "2026-10-21T00:00:00.000Z",
  archivedAt: null,
  lastRunId: null,
}

describe("AppStore batching", () => {
  it("replays a whole history with one notification and the same result as one by one", () => {
    const history = Array.from({ length: 500 }, (_, index) =>
      threadEvent(
        "th_1",
        index + 1,
        index % 50 === 0 ? "run.started" : index % 50 === 49 ? "run.completed" : "tool.completed",
      ),
    )
    const batched = new AppStore()
    batched.openThread("th_1")
    batched.setActiveThread("th_1")
    let notifications = 0
    batched.subscribe(() => {
      notifications += 1
    })
    batched.addEvents(history)
    expect(notifications).toBe(1)

    const single = new AppStore()
    single.openThread("th_1")
    single.setActiveThread("th_1")
    for (const event of history) single.addEvent(event)
    expect(batched.getSnapshot().threadStates["th_1"]).toEqual(
      single.getSnapshot().threadStates["th_1"],
    )
    expect(batched.getSnapshot().events).toHaveLength(500)
  })

  it("skips events it already has, even when they arrive again out of order", () => {
    const store = new AppStore()
    store.openThread("th_1")
    store.addEvents([
      threadEvent("th_1", 1, "run.started"),
      threadEvent("th_1", 2, "approval.requested"),
    ])
    store.addEvents([
      threadEvent("th_1", 2, "approval.requested"),
      threadEvent("th_1", 3, "approval.resolved"),
    ])
    const state = store.getSnapshot().threadStates["th_1"]
    expect(state?.events.map((event) => event.seq)).toEqual([1, 2, 3])
    expect(state?.pendingApprovals).toBe(0)
  })

  it("merges streaming deltas into one update per frame", () => {
    const frames = manualSchedule()
    const store = new AppStore({ schedule: frames.schedule })
    store.openThread("th_1")
    store.setActiveThread("th_1")
    let notifications = 0
    store.subscribe(() => {
      notifications += 1
    })
    for (const word of ["Hel", "lo", " wor", "ld"]) store.queueDelta("th_1", word)
    expect(store.getSnapshot().streamingText).toBe("")
    expect(notifications).toBe(0)
    frames.flush()
    expect(store.getSnapshot().streamingText).toBe("Hello world")
    expect(notifications).toBe(1)
  })

  it("writes queued text before the event that ends the stream", () => {
    const frames = manualSchedule()
    const store = new AppStore({ schedule: frames.schedule })
    store.openThread("th_1")
    store.setActiveThread("th_1")
    store.queueDelta("th_1", "final answer")
    store.addEvent(
      threadEvent("th_1", 1, "message.completed", { role: "assistant", text: "final answer" }),
    )
    // 完成事件之后的帧不能把已经落成消息的文本再写回流式区。
    frames.flush()
    expect(store.getSnapshot().streamingText).toBe("")
    expect(store.getSnapshot().threadStates["th_1"]?.streamingText).toBe("")
  })

  it("applies title, permission mode and agent switches from thread.updated", () => {
    const store = new AppStore()
    store.update({ threads: [thread] })
    store.openThread("th_1")
    store.addEvents([
      threadEvent("th_1", 1, "thread.updated", { title: "New title" }, null),
      threadEvent("th_1", 2, "thread.updated", { permissionMode: "plan" }, null),
      threadEvent(
        "th_1",
        3,
        "thread.updated",
        { agentId: "codex", modelId: "gpt-6.1-sol", handoff: "x" },
        null,
      ),
      threadEvent("th_1", 4, "thread.updated", { permissionMode: "invalid/permission" }, null),
    ])
    expect(store.getSnapshot().threads[0]).toMatchObject({
      title: "New title",
      permissionMode: "workspace-write",
      planMode: true,
      lastAgentId: "codex",
      lastModelId: "gpt-6.1-sol",
    })
  })

  it("collects a running command's output per frame and drops it once the command ends", () => {
    const frames = manualSchedule()
    const store = new AppStore({ schedule: frames.schedule })
    store.openThread("th_1")
    let notifications = 0
    store.subscribe(() => {
      notifications += 1
    })
    store.queueToolOutput("th_1", "c1", "line 1\n")
    store.queueToolOutput("th_1", "c1", "line 2\n")
    store.queueToolOutput("th_1", "c2", "other\n")
    store.queueToolOutput("th_gone", "c9", "late\n")
    expect(notifications).toBe(0)
    frames.flush()
    expect(notifications).toBe(1)
    expect(store.getSnapshot().threadStates["th_1"]?.liveOutput).toEqual({
      c1: "line 1\nline 2\n",
      c2: "other\n",
    })
    expect(store.getSnapshot().threadStates["th_gone"]).toBeUndefined()

    // 新事件到达前先写入排队的输出；命令结束后由完整输出取代，run 结束时全部清掉。
    store.queueToolOutput("th_1", "c1", "line 3\n")
    store.addEvents([threadEvent("th_1", 1, "tool.completed", { toolCallId: "c1" })])
    expect(store.getSnapshot().threadStates["th_1"]?.liveOutput).toEqual({ c2: "other\n" })
    store.addEvents([threadEvent("th_1", 2, "run.completed")])
    expect(store.getSnapshot().threadStates["th_1"]?.liveOutput).toEqual({})
  })

  it("streams thinking per frame until the reasoning or a tool call lands", () => {
    const frames = manualSchedule()
    const store = new AppStore({ schedule: frames.schedule })
    store.openThread("th_1")
    store.queueReasoning("th_1", "Read the ")
    store.queueReasoning("th_1", "tests first")
    frames.flush()
    expect(store.getSnapshot().threadStates["th_1"]?.liveReasoning).toBe("Read the tests first")

    // 子 agent 的思考不影响主线程；主线程的思考落成事件后实时文字清空。
    store.addEvents([
      threadEvent("th_1", 1, "reasoning.completed", { text: "x", parentToolUseId: "task_1" }),
    ])
    expect(store.getSnapshot().threadStates["th_1"]?.liveReasoning).toBe("Read the tests first")
    store.addEvents([threadEvent("th_1", 2, "reasoning.completed", { text: "Read the tests" })])
    expect(store.getSnapshot().threadStates["th_1"]?.liveReasoning).toBe("")

    store.queueReasoning("th_1", "next step")
    frames.flush()
    store.addEvents([threadEvent("th_1", 3, "tool.started", { toolCallId: "c1", name: "Read" })])
    expect(store.getSnapshot().threadStates["th_1"]?.liveReasoning).toBe("")
  })
})
