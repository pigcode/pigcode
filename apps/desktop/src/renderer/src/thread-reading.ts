import { useEffect, useMemo, useRef } from "react"
import type { Connection } from "@pigcode/client-runtime"
import type { ThreadEvent, ThreadReadTarget } from "@pigcode/contracts"
import { useDesktopForeground } from "./desktop-reminder-navigation"

interface ThreadReading {
  threadId: string | null
  connected: boolean
  unread: boolean | undefined
  target: ThreadReadTarget | undefined
  manualUnread?: ThreadReadTarget | undefined
  timeline: { loaded: boolean; events: readonly ThreadEvent[] } | undefined
}

type ViewedResult = ThreadReadTarget & { threadId: string; attempt?: { connectionRevision: number } }

function shownResult(events: readonly ThreadEvent[] | undefined): string | null {
  if (!events) return null
  for (let index = events.length - 1; index >= 0; index--) {
    const event = events[index]!
    if (event.type === "run.completed" || event.type === "run.failed" || event.type === "run.interrupted")
      return event.runId
  }
  return null
}

export function useThreadReading(
  connection: Connection,
  { threadId, connected, unread, target, manualUnread, timeline }: ThreadReading,
): void {
  const foreground = useDesktopForeground()
  const viewed = useRef<ViewedResult | null>(null)
  const events = timeline?.loaded ? timeline.events : undefined
  const runId = useMemo(() => shownResult(events), [events])
  const connectionRevision = connection.connectionRevision
  useEffect(() => {
    if (viewed.current?.threadId !== threadId) viewed.current = null
    if (!threadId || !foreground || !connected || !runId) return
    if (viewed.current?.runId !== runId) {
      viewed.current = { threadId, runId, revision: manualUnread?.runId === runId ? manualUnread.revision : 0 }
    }
    const result = viewed.current
    if (!unread || target?.runId !== runId || result.revision !== target.revision ||
        result.attempt?.connectionRevision === connectionRevision) return
    const attempt = { connectionRevision }
    result.attempt = attempt
    void connection.call("thread.acknowledgeRead", { threadId, ...target }).catch(() => {
      if (result.attempt === attempt) delete result.attempt
    })
  }, [connection, connectionRevision, threadId, foreground, connected, unread, target, manualUnread, runId])
}
