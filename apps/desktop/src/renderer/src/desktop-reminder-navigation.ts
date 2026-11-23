import { useEffect, useRef, useSyncExternalStore } from "react"
import { hostReminderSchema, type Project, type Thread } from "@pigcode/contracts"
import type { CoreDeps } from "./chat-container"

function foreground(): boolean {
  return document.visibilityState === "visible" && document.hasFocus()
}

function watchForeground(changed: () => void): () => void {
  window.addEventListener("focus", changed)
  window.addEventListener("blur", changed)
  document.addEventListener("visibilitychange", changed)
  return () => {
    window.removeEventListener("focus", changed)
    window.removeEventListener("blur", changed)
    document.removeEventListener("visibilitychange", changed)
  }
}

export function useDesktopForeground(): boolean {
  return useSyncExternalStore(watchForeground, foreground)
}

export function useDesktopReminderNavigation(
  { connection, store }: Pick<CoreDeps, "connection" | "store">,
  connected: boolean,
  open: (id: string) => void,
  unavailable: () => void,
) {
  const actions = useRef({ open, unavailable })
  actions.current = { open, unavailable }
  useEffect(() => {
    const bridge = window.pigcodeNative
    if (!connected || !bridge?.pendingReminder || !bridge.finishReminder) return
    let disposed = false
    let generation = 0
    const read = async () => {
      const current = ++generation
      const parsed = hostReminderSchema.safeParse(await bridge.pendingReminder?.())
      if (disposed || current !== generation || !parsed.success) return
      const { threadId, eventId } = parsed.data
      try {
        const [threads, projects] = await Promise.all([
          connection.call("thread.list", {}) as Promise<Thread[]>,
          connection.call("project.list", {}) as Promise<Project[]>,
        ])
        const snapshot = store.getSnapshot()
        if (disposed || current !== generation || snapshot.status !== "connected") return
        const thread = threads.find((item) => item.id === threadId && !item.archivedAt && !item.parentThreadId)
        const liveProjects = connection.hasProjectSnapshot ? snapshot.projects : projects
        if (!thread || !liveProjects.some((project) => project.id === thread.projectId)) {
          actions.current.unavailable()
        } else {
          store.update({ threads: snapshot.threads.some((item) => item.id === thread.id)
            ? snapshot.threads.map((item) => item.id === thread.id ? thread : item)
            : [...snapshot.threads, thread] })
          actions.current.open(thread.id)
        }
        await bridge.finishReminder?.(eventId)
      } catch {
        // Main retains the tapped target so the next Host connection can resolve it.
      }
    }
    const received = () => { void read().catch(() => undefined) }
    const unsubscribe = bridge.onReminderReady?.(received)
    received()
    return () => {
      disposed = true
      unsubscribe?.()
    }
  }, [connected, connection, store])
}
