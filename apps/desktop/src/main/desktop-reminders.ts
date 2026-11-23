import { ipcMain, Notification, type BrowserWindow, type MessagePortMain } from "electron"
import { hostReminderSchema, type HostReminder } from "@pigcode/contracts"
import { reminderText } from "./locale/reminders"

interface ReminderWindow {
  window(): BrowserWindow | undefined
  enabled(): boolean
  locale(): string
  raise(): void
}

export function createDesktopReminders(options: ReminderWindow) {
  let pending: HostReminder | undefined
  let activePort: MessagePortMain | undefined
  const shown = new Map<string, Notification>()

  const wake = () => {
    const window = options.window()
    if (pending && window && !window.isDestroyed() && !window.webContents.isDestroyed()) {
      window.webContents.send("pigcode:reminder-ready")
    }
  }

  ipcMain.handle("pigcode:pending-reminder", (event) => {
    if (event.sender !== options.window()?.webContents) return null
    return pending ?? null
  })

  ipcMain.handle("pigcode:finish-reminder", (event, eventId: unknown) => {
    if (event.sender === options.window()?.webContents && pending?.eventId === eventId) {
      pending = undefined
    }
  })

  function attach(port: MessagePortMain): void {
    activePort = port
    port.on("message", ({ data }) => {
      if (activePort !== port || data?.type !== "host.reminder" || !options.enabled()) return
      const window = options.window()
      if (window && !window.isDestroyed() && window.isVisible() && window.isFocused()) return
      const result = hostReminderSchema.safeParse(data.reminder)
      if (!result.success || !Notification.isSupported()) return
      const reminder = result.data
      if (shown.has(reminder.eventId)) return
      const notification = new Notification({
        title: "Pigcode",
        body: reminderText(options.locale(), reminder.kind),
      })
      shown.set(reminder.eventId, notification)
      if (shown.size > 512) shown.delete(shown.keys().next().value!)
      notification.once("click", () => {
        pending = reminder
        options.raise()
        wake()
      })
      notification.show()
    })
    port.start()
  }

  return { attach, wake }
}
