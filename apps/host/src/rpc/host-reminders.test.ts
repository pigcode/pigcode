import type { ThreadEvent } from "@pigcode/contracts"
import { expect, it, vi } from "vitest"
import { FAKE_APPROVAL_TEXT, FAKE_ASK_TEXT, FAKE_FAIL_TEXT } from "../agents/fake"
import { attachHostReminders } from "./host-reminders"
import { startMobileHost } from "./mobile-test-fixture"

it("defers pending requests and delivers unique reminders per target", async () => {
  const host = await startMobileHost()
  const { ctx } = host
  const project = ctx.projects.add("/tmp/pigcode-reminders-fixture", "通知验收")
  const approval = ctx.threads.create(project.id, "审批", "fake")
  const question = ctx.threads.create(project.id, "提问", "fake")
  const failure = ctx.threads.create(project.id, "失败", "fake")
  const desktop = vi.fn()
  const anotherTarget = vi.fn()
  vi.useFakeTimers()
  attachHostReminders(ctx, desktop)
  attachHostReminders(ctx, anotherTarget)

  function repeat(threadId: string, type: ThreadEvent["type"]) {
    const event = ctx.sessions.read(threadId, 0).find((item) => item.type === type)
    if (!event) throw new Error("missing fixture event")
    ctx.sessions.append({ ...event })
  }

  try {
    const first = await ctx.agents.startRun(approval.id, FAKE_APPROVAL_TEXT)
    const [pending] = ctx.agents.listPendingRequests(approval.id)
    expect(pending?.kind).toBe("approval")
    await vi.advanceTimersByTimeAsync(799)
    expect(desktop).not.toHaveBeenCalled()
    ctx.agents.respondApproval(approval.id, first.runId, pending!.id, "deny")
    await first.done
    repeat(approval.id, "run.completed")
    await vi.advanceTimersByTimeAsync(1)
    expect(desktop).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
      kind: "completed", threadId: approval.id, eventId: "result:" + first.runId,
    }))

    const waiting = await ctx.agents.startRun(question.id, FAKE_ASK_TEXT)
    repeat(question.id, "question.requested")
    await vi.advanceTimersByTimeAsync(800)
    const [request] = ctx.agents.listPendingRequests(question.id)
    expect(desktop).toHaveBeenCalledTimes(2)
    expect(desktop).toHaveBeenLastCalledWith(expect.objectContaining({
      kind: "question", threadId: question.id, eventId: "request:" + request!.id,
    }))
    ctx.agents.cancelRun(waiting.runId)
    await waiting.done

    const bad = await ctx.agents.startRun(failure.id, FAKE_FAIL_TEXT)
    await bad.done
    repeat(failure.id, "run.failed")
    expect(desktop).toHaveBeenCalledTimes(3)
    expect(desktop).toHaveBeenLastCalledWith(expect.objectContaining({
      kind: "failed", threadId: failure.id, eventId: "result:" + bad.runId,
    }))
    expect(anotherTarget.mock.calls).toEqual(desktop.mock.calls)
  } finally {
    ctx.agents.cancelAll()
    await host.stop()
    vi.useRealTimers()
  }
})

it("skips a result the target session already read", async () => {
  const host = await startMobileHost()
  const { ctx } = host
  const project = ctx.projects.add("/tmp/pigcode-read-reminder-fixture", "通知验收")
  const thread = ctx.threads.create(project.id, "已读结果", "fake")
  const send = vi.fn()
  const unsubscribe = ctx.sessions.subscribeAll((event) => {
    if (event.threadId === thread.id && event.type === "run.failed") {
      ctx.threads.markRead(thread.id, true)
    }
  })
  attachHostReminders(ctx, send)

  try {
    const run = await ctx.agents.startRun(thread.id, FAKE_FAIL_TEXT)
    await run.done
    expect(ctx.threads.get(thread.id)?.unread).toBe(false)
    expect(send).not.toHaveBeenCalled()
  } finally {
    unsubscribe()
    await host.stop()
  }
})
