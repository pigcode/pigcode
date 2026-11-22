/** Publish updated sidebar records after the corresponding Host writes finish. */
import type { Context } from "cordis"
import type { Thread, ThreadEvent } from "@pigcode/contracts"

const THREAD_CHANGES = new Set<ThreadEvent["type"]>([
  "thread.created",
  "thread.updated",
  "run.queued",
  "run.started",
  "run.completed",
  "run.failed",
  "run.interrupted",
  "approval.requested",
  "approval.resolved",
  "question.requested",
  "question.answered",
])

export class ThreadFeed {
  private readonly pending = new Set<string>()
  private readonly listeners = new Set<(thread: Thread) => void>()
  private stopEvents: (() => void) | undefined

  constructor(private readonly ctx: Context) {}

  subscribe(listener: (thread: Thread) => void): () => void {
    if (this.listeners.size === 0) {
      this.stopEvents = this.ctx.get("sessions")?.subscribeAll((event) => {
        if (THREAD_CHANGES.has(event.type)) this.changed(event.threadId)
      })
    }
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
      if (this.listeners.size === 0) {
        this.stopEvents?.()
        this.stopEvents = undefined
      }
    }
  }

  /** run 和待处理请求可能分几步写入，同一批同步修改合并后再读。 */
  changed(threadId: string): void {
    if (this.listeners.size === 0) return
    if (this.pending.size === 0) queueMicrotask(() => this.flush())
    this.pending.add(threadId)
  }

  private flush(): void {
    const ids = [...this.pending]
    this.pending.clear()
    for (const id of ids) {
      const thread = this.ctx.threads.get(id)
      if (thread) {
        for (const listener of [...this.listeners]) listener(thread)
      }
    }
  }
}
