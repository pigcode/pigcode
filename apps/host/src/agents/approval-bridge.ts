/** 审批请求的等待表；id 与持久化行一致。 */
import { randomUUID } from "node:crypto"
import type { ThreadEvent } from "@pigcode/contracts"
import type { ApprovalDecision, ApprovalRequest } from "./driver"
import type { ApprovalHandle } from "./service"
import type { ActiveRun } from "./run-queue"
import type { PigcodeDatabase } from "../storage/database"
import type { PendingRequestStore } from "../storage/pending-request-store"
import type { RunStore } from "../storage/run-store"
import { approvalDecisions } from "./run-requests"

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

  has(id: string): boolean {
    return this.waiters.has(id)
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

export function createApprovalRequest(
  db: PigcodeDatabase,
  approvals: ApprovalBridge,
  pendingRequests: PendingRequestStore,
  runs: RunStore,
  activeRuns: Map<string, ActiveRun>,
  append: (threadId: string, runId: string, type: ThreadEvent["type"], payload: unknown) => void,
) {
  /** 发起审批：持久化 pending 行、写事件、置为 waiting-approval 并等待 UI 决议。 */
  return function requestApproval(
    threadId: string,
    runId: string,
    request: ApprovalRequest,
  ): ApprovalHandle {
    const runRow = db.prepare(`SELECT thread_id FROM runs WHERE id = ?`).get(runId) as
      { thread_id: string } | undefined
    if (!runRow || runRow.thread_id !== threadId) throw new Error(`run not found: ${runId}`)

    const requestId = `req_${randomUUID()}`
    const approval = { ...request, decisions: approvalDecisions(request) }
    pendingRequests.create({
      id: requestId,
      threadId,
      runId,
      kind: "approval",
      agentRequestId: null,
      payload: approval,
      createdAt: new Date().toISOString(),
    })
    runs.setStatus(runId, "waiting-approval")
    const active = activeRuns.get(runId)
    if (active) {
      active.status = "waiting-approval"
      active.approvals.add(requestId)
    }
    const decision = approvals.wait(requestId, { threadId, runId })
    append(threadId, runId, "approval.requested", {
      requestId,
      id: requestId,
      ...approval,
    })
    return { requestId, decision }
  }
}
