// @vitest-environment jsdom
import { AppStore, type Connection } from "@pigcode/client-runtime"
import type { Project, Thread } from "@pigcode/contracts"
import { renderHook, waitFor } from "@testing-library/react"
import { afterEach, expect, it, vi } from "vitest"
import { useDesktopReminderNavigation } from "./desktop-reminder-navigation"

const time = "2026-11-23T00:30:00.000Z"
const project: Project = { id: "project", name: "通知验收", rootPath: "/tmp/pigcode", createdAt: time }
const thread: Thread = {
  id: "target", projectId: project.id, title: "通知目标", defaultAgentId: "fake",
  defaultInstanceId: null, lastAgentId: null, lastInstanceId: null, lastModelId: null,
  permissionMode: "workspace-write", createdAt: time, updatedAt: time, archivedAt: null,
  lastRunId: null,
}

function fixture() {
  const store = new AppStore()
  store.update({ status: "connected", projects: [project] })
  const pendingReminder = vi.fn(async () => ({
    version: 1, eventId: "request:fixture", threadId: thread.id, kind: "approval",
  }))
  const finishReminder = vi.fn(async () => undefined)
  vi.stubGlobal("pigcodeNative", { pendingReminder, finishReminder })
  const opened = vi.fn()
  const unavailable = vi.fn()
  const connection = {
    call: vi.fn(async (method: string) => method === "thread.list" ? [thread] : [project]),
    hasProjectSnapshot: true,
  }
  const render = () => renderHook(
    ({ connected }) => useDesktopReminderNavigation({
      connection: connection as unknown as Connection, store,
    }, connected, opened, unavailable),
    { initialProps: { connected: true } },
  )
  return { store, connection, opened, unavailable, finishReminder, render }
}

afterEach(() => vi.unstubAllGlobals())

it("keeps a tapped reminder available if the Host restarts during validation", async () => {
  const { connection, render, opened, finishReminder } = fixture()
  connection.call.mockRejectedValueOnce(new Error("host connection lost"))
  const hook = render()
  await waitFor(() => expect(connection.call).toHaveBeenCalledTimes(2))
  expect(opened).not.toHaveBeenCalled()
  expect(finishReminder).not.toHaveBeenCalled()

  hook.rerender({ connected: false })
  hook.rerender({ connected: true })
  await waitFor(() => expect(opened).toHaveBeenCalledExactlyOnceWith(thread.id))
  expect(finishReminder).toHaveBeenCalledExactlyOnceWith("request:fixture")
  hook.unmount()
})

it("does not reopen a thread from a project removed while validating a reminder", async () => {
  const { connection, store, render, opened, unavailable, finishReminder } = fixture()
  connection.call.mockImplementationOnce(async () => {
    store.update({ projects: [] })
    return [thread]
  })
  const hook = render()
  await waitFor(() => expect(unavailable).toHaveBeenCalledTimes(1))
  expect(opened).not.toHaveBeenCalled()
  expect(store.getSnapshot().threads).toEqual([])
  expect(finishReminder).toHaveBeenCalledExactlyOnceWith("request:fixture")
  hook.unmount()
})
