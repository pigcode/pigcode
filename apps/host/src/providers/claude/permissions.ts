/** 审批请求的等待表；id 与持久化行一致。 */
import type { ApprovalDecision } from "../driver"

/** 一个等待 UI 决议的审批请求；Host 关闭时可统一拒绝。 */
export interface Waiter {
  threadId: string
  runId: string
  resolve(decision: ApprovalDecision): void
  reject(error: Error): void
}

/** 发起等待时由调用方提供的关联信息。 */
export type WaiterInput = Omit<Waiter, "resolve" | "reject">

/** 把持久化请求 id 映射到正在等待的 Promise resolver。 */
export class ApprovalBridge {
  private readonly waiters = new Map<string, Waiter>()

  /** 注册一个等待者；返回在 resolve/reject 时结束的 promise。 */
  wait(id: string, waiter: WaiterInput): Promise<ApprovalDecision> {
    return new Promise((resolve, reject) => {
      this.waiters.set(id, { ...waiter, resolve, reject })
    })
  }

  /** 完成指定请求；不存在时返回 false。 */
  resolve(id: string, decision: ApprovalDecision): boolean {
    const waiter = this.waiters.get(id)
    if (!waiter) return false
    this.waiters.delete(id)
    waiter.resolve(decision)
    return true
  }

  /** Host 关闭时拒绝所有等待者，避免调用方永久挂起。 */
  rejectAll(error: Error): void {
    for (const waiter of this.waiters.values()) waiter.reject(error)
    this.waiters.clear()
  }
}
