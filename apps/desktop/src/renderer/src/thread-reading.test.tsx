// @vitest-environment jsdom
import { act, cleanup, renderHook, waitFor } from "@testing-library/react"
import type { Connection } from "@pigcode/client-runtime"
import type { ThreadEvent, ThreadReadTarget } from "@pigcode/contracts"
import { afterEach, expect, it, vi } from "vitest"
import { useThreadReading } from "./thread-reading"

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

const completed: ThreadEvent = {
  seq: 1,
  threadId: "thread",
  runId: "run",
  type: "run.completed",
  schemaVersion: 1,
  payload: {},
  createdAt: "2026-11-23T04:00:00.000Z",
}

it("confirms only displayed online results and leaves a manually unread result alone until reentry", async () => {
  const focus = vi.spyOn(document, "hasFocus").mockReturnValue(false)
  const visibility = vi.spyOn(document, "visibilityState", "get").mockReturnValue("hidden")
  const call = vi.fn(async () => ({}))
  const connection = { call, connectionRevision: 1 } as unknown as Connection
  const initialProps = {
    threadId: "thread" as string | null,
    connected: true,
    unread: true,
    target: { runId: "run", revision: 0 },
    manualUnread: undefined as ThreadReadTarget | undefined,
    timeline: { loaded: true, events: [completed] },
  }
  const { rerender } = renderHook((props) => useThreadReading(connection, props), { initialProps })
  expect(call).not.toHaveBeenCalled()

  rerender({ ...initialProps, connected: false })
  act(() => {
    focus.mockReturnValue(true)
    window.dispatchEvent(new Event("focus"))
  })
  expect(call).not.toHaveBeenCalled()
  rerender({ ...initialProps, timeline: { loaded: true, events: [] } })
  expect(call).not.toHaveBeenCalled()
  rerender(initialProps)
  expect(call).not.toHaveBeenCalled()
  act(() => {
    visibility.mockReturnValue("visible")
    document.dispatchEvent(new Event("visibilitychange"))
  })
  await waitFor(() => expect(call).toHaveBeenCalledExactlyOnceWith(
    "thread.acknowledgeRead", { threadId: "thread", runId: "run", revision: 0 },
  ))

  const marked = { runId: "run", revision: 1 }
  const manualUnread = { ...initialProps, target: marked, manualUnread: marked }
  rerender(manualUnread)
  expect(call).toHaveBeenCalledTimes(1)
  rerender({ ...manualUnread, threadId: null })
  rerender(manualUnread)
  await waitFor(() => expect(call).toHaveBeenLastCalledWith(
    "thread.acknowledgeRead", { threadId: "thread", runId: "run", revision: 1 },
  ))
})

it("remembers the result before the sidebar publishes its read target", () => {
  vi.spyOn(document, "hasFocus").mockReturnValue(true)
  vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible")
  const call = vi.fn(async () => ({}))
  const connection = { call, connectionRevision: 1 } as unknown as Connection
  const initialProps = {
    threadId: "thread", connected: true, unread: false,
    target: undefined as ThreadReadTarget | undefined,
    manualUnread: undefined as ThreadReadTarget | undefined,
    timeline: { loaded: true, events: [completed] },
  }
  const { rerender } = renderHook((props) => useThreadReading(connection, props), { initialProps })
  const marked = { runId: "run", revision: 1 }
  rerender({ ...initialProps, unread: true, target: marked, manualUnread: marked })
  expect(call).not.toHaveBeenCalled()
})
