/**
 * 会话记录变了就推一份新的（thread.changed）给页面：状态、未读、标题、更新时间、归档。
 * 没打开过的会话收不到事件，侧栏里它的状态和时间全靠这个更新。
 */
import type { Context } from "cordis"
import type { ThreadEvent } from "@pigcode/contracts"

/** 写入后会话的状态、标题或更新时间可能变了的事件。 */
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
  /** 等着推的会话；同一段同步代码里的几次变化只推一次。 */
  private readonly pending = new Set<string>()
  private running = false

  constructor(
    private readonly ctx: Context,
    private readonly send: (message: unknown) => void,
  ) {}

  /** 跟着会话事件推送；返回停止的函数。 */
  start(): () => void {
    this.running = true
    const off = this.ctx.get("sessions")?.subscribeAll((event) => {
      if (THREAD_CHANGES.has(event.type)) this.changed(event.threadId)
    })
    return () => {
      this.running = false
      off?.()
    }
  }

  /**
   * 这个会话的记录变了。run 的状态、待处理请求和事件不按同一个先后写入，
   * 等这一段同步代码跑完再读，推出去的是写完以后的样子。
   */
  changed(threadId: string): void {
    if (this.pending.size === 0) queueMicrotask(() => this.flush())
    this.pending.add(threadId)
  }

  private flush(): void {
    const ids = [...this.pending]
    this.pending.clear()
    if (!this.running) return
    for (const id of ids) {
      const thread = this.ctx.threads.get(id)
      if (thread) this.send({ jsonrpc: "2.0", method: "thread.changed", params: thread })
    }
  }
}
