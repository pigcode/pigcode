import { hostReminderSchema, type HostReminder, type ThreadEvent } from "@pigcode/contracts"
import type { Context } from "cordis"

const requestDelayMs = 800
const recentLimit = 2048

function reminderFor(event: ThreadEvent) {
  const { threadId, runId, type } = event
  if (runId === null) return
  if (type === "run.completed" || type === "run.failed") {
    return {
      runId,
      reminder: { version: 1, eventId: `result:${runId}`, threadId,
        kind: type === "run.completed" ? "completed" : "failed" },
    } as const
  }
  if (type === "approval.requested" || type === "question.requested") {
    const requestId = (event.payload as { requestId?: unknown } | null)?.requestId
    if (typeof requestId !== "string" || !requestId) return
    return {
      runId, requestId,
      reminder: { version: 1, eventId: `request:${requestId}`, threadId,
        kind: type === "approval.requested" ? "approval" : "question" },
    } as const
  }
}

/** One delivery subscription per target. Only live Host events can create reminders. */
export function attachHostReminders(ctx: Context, send: (reminder: HostReminder) => void): void {
  ctx.effect(() => {
    const recent = new Set<string>()
    const pending = new Map<string, ReturnType<typeof setTimeout>>()
    const unsubscribe = ctx.sessions.subscribeAll((event) => {
      const candidate = reminderFor(event)
      if (!candidate) return
      const parsed = hostReminderSchema.safeParse(candidate.reminder)
      if (!parsed.success) return
      const reminder = parsed.data
      if (recent.has(reminder.eventId) || pending.has(reminder.eventId)) return

      const deliver = () => {
        pending.delete(reminder.eventId)
        recent.add(reminder.eventId)
        if (recent.size > recentLimit) recent.delete(recent.values().next().value!)
        const thread = ctx.threads.get(reminder.threadId)
        if (!thread || thread.parentThreadId || thread.archivedAt ||
            !ctx.projects.list().some((project) => project.id === thread.projectId)) return
        const { requestId, runId } = candidate
        const current = requestId
          ? ctx.agents.listPendingRequests(thread.id).some((request) =>
              request.id === requestId && request.runId === runId && request.kind === reminder.kind)
          : thread.lastRunId === runId && thread.unread && ctx.agents.getRunStatus(runId) === reminder.kind
        if (!current) return
        try {
          send(reminder)
        } catch (error) {
          console.error("[host] reminder delivery failed", error)
        }
      }

      if (candidate.requestId) {
        pending.set(reminder.eventId, setTimeout(deliver, requestDelayMs).unref())
      } else {
        deliver()
      }
    })
    return () => {
      unsubscribe()
      for (const timer of pending.values()) clearTimeout(timer)
      pending.clear()
    }
  })
}
