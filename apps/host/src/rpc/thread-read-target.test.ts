import { expect, it, vi } from "vitest"
import { FAKE_FAIL_TEXT } from "../agents/fake"
import { startMobileHost } from "./mobile-test-fixture"

it("only marks the viewed result read and rejects a receipt superseded by a manual unread", async () => {
  const host = await startMobileHost()
  vi.useFakeTimers({ toFake: ["Date"] })
  vi.setSystemTime(new Date("2026-11-23T04:00:00.000Z"))
  try {
    const project = host.ctx.projects.add("/tmp/pigcode-read-target-fixture", "未读验收")
    const thread = host.ctx.threads.create(project.id, "同一毫秒的两轮", "fake")
    const confirm = (runId: string, revision = 0) =>
      host.call("thread.acknowledgeRead", { threadId: thread.id, runId, revision })

    const first = await host.ctx.agents.startRun(thread.id, FAKE_FAIL_TEXT)
    await first.done
    expect(await confirm(first.runId)).toMatchObject({ result: { unread: false } })

    const recent = await host.ctx.agents.startRun(thread.id, FAKE_FAIL_TEXT)
    await recent.done
    const untouched = {
      unread: true,
      readTarget: { runId: recent.runId, revision: 0 },
    }
    expect(await host.call("thread.list")).toMatchObject({ result: [untouched] })
    expect(await confirm(first.runId)).toMatchObject({ result: untouched })

    expect(await host.call("thread.markRead", { threadId: thread.id, read: false })).toMatchObject({
      result: { unread: true, readTarget: { runId: recent.runId, revision: 1 } },
    })
    expect(await confirm(recent.runId)).toMatchObject({ result: { unread: true } })
    expect(await confirm(recent.runId, 1)).toMatchObject({ result: { unread: false } })

    const next = await host.ctx.agents.startRun(thread.id, FAKE_FAIL_TEXT)
    await next.done
    expect(await host.call("thread.list")).toMatchObject({ result: [{
      unread: true,
      readTarget: { runId: next.runId, revision: 0 },
      manualUnread: { runId: recent.runId, revision: 1 },
    }] })
    expect(await confirm(next.runId)).toMatchObject({ result: { unread: false } })
  } finally {
    vi.useRealTimers()
    await host.stop()
  }
})
