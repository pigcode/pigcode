import { EventEmitter } from "node:events"
import type { BrowserWindow, MessagePortMain } from "electron"
import { expect, it, vi } from "vitest"
import { createDesktopReminders } from "./desktop-reminders"

const fixture = vi.hoisted(() => ({
  shown: vi.fn(),
  handle: vi.fn(),
}))

vi.mock("electron", async () => {
  const { EventEmitter } = await import("node:events")
  return {
    ipcMain: { handle: fixture.handle },
    Notification: class extends EventEmitter {
      static isSupported() { return true }
      constructor(private readonly display: unknown) { super() }
      show() { fixture.shown(this.display, this) }
    },
  }
})

it("uses the OS in the background and opens the reminder target only in the app window", () => {
  const signal = vi.fn()
  let focused = true
  let enabled = true
  const window = {
    isDestroyed: () => false,
    isVisible: () => true,
    isFocused: () => focused,
    webContents: { isDestroyed: () => false, send: signal },
  } as unknown as BrowserWindow
  const raise = vi.fn()
  const control = Object.assign(new EventEmitter(), { start: vi.fn() })
  const reminders = createDesktopReminders({
    window: () => window, enabled: () => enabled, raise, locale: () => "zh-CN",
  })
  reminders.attach(control as unknown as MessagePortMain)
  const reminder = { version: 1, eventId: "request:req_one", threadId: "thread-one", kind: "approval" }
  const receive = () => control.emit("message", { data: { type: "host.reminder", reminder } })
  receive()
  expect(fixture.shown).not.toHaveBeenCalled()
  focused = false
  enabled = false
  receive()
  expect(fixture.shown).not.toHaveBeenCalled()
  enabled = true
  receive()
  receive()
  expect(fixture.shown).toHaveBeenCalledTimes(1)
  const [display, handle] = fixture.shown.mock.calls[0]!
  expect(display).toEqual({ title: "Pigcode", body: "等你处理" })
  handle.emit("click")
  expect(raise).toHaveBeenCalledTimes(1)
  expect(signal).toHaveBeenCalledWith("pigcode:reminder-ready")
  const read = fixture.handle.mock.calls[0]![1]
  const finish = fixture.handle.mock.calls[1]![1]
  const sender = { sender: window.webContents }
  expect(read({ sender: {} })).toBeNull()
  expect(read(sender)).toEqual(reminder)
  finish({ sender: {} }, reminder.eventId)
  finish(sender, "stale-id")
  expect(read(sender)).toEqual(reminder)
  finish(sender, reminder.eventId)
  expect(read(sender)).toBeNull()
})
