/**
 * agent 向用户提问（例如 Claude 的 AskUserQuestion）：持久化待回答请求、写 question.requested、
 * 把线程置为 waiting-input，等用户在界面上作答后交回 driver。run 结束时未回答的问题以空答案结束，
 * driver 据此拒绝这次提问，不会永远挂起。
 */
import { randomUUID } from "node:crypto"
import type { ThreadEvent } from "@pigcode/contracts"
import type { PendingRequestStore } from "../storage/pending-request-store"
import type { RunStore } from "../storage/run-store"
import type { QuestionRequest } from "./driver"
import type { ActiveRun } from "./run-queue"

/** 提问流程需要的 registry 能力。 */
export interface QuestionDeps {
  append(threadId: string, runId: string | null, type: ThreadEvent["type"], payload: unknown): void
  pendingRequests: PendingRequestStore
  runs: RunStore
  activeRuns: Map<string, ActiveRun>
}

/** 提问的发起、作答与 run 结束时的清理。 */
export function createQuestionFlow(deps: QuestionDeps) {
  const waiters = new Map<string, { runId: string; resolve: (answers: string[]) => void }>()

  function finish(run: ActiveRun | undefined, runId: string, requestId: string): void {
    deps.pendingRequests.resolve(requestId)
    if (!run) return
    run.approvals.delete(requestId)
    if (run.approvals.size === 0) {
      run.status = "running"
      deps.runs.setStatus(runId, "running")
    }
  }

  return {
    /** 发起提问，返回每个问题的答案（与问题顺序一致）。 */
    ask(run: ActiveRun, request: QuestionRequest): Promise<string[]> {
      const requestId = `q_${randomUUID()}`
      deps.pendingRequests.create({
        id: requestId,
        threadId: run.threadId,
        runId: run.runId,
        kind: "question",
        agentRequestId: null,
        payload: request,
        createdAt: new Date().toISOString(),
      })
      deps.append(run.threadId, run.runId, "question.requested", {
        requestId,
        id: requestId,
        questions: request.questions,
      })
      deps.runs.setStatus(run.runId, "waiting-input")
      run.status = "waiting-input"
      run.approvals.add(requestId)
      return new Promise((resolve) => waiters.set(requestId, { runId: run.runId, resolve }))
    },
    /** 用户作答；请求不属于这个 run 或已经结束时抛错。 */
    answer(threadId: string, runId: string, requestId: string, answers: string[]): void {
      const waiter = waiters.get(requestId)
      const run = deps.activeRuns.get(runId)
      if (!waiter || waiter.runId !== runId || (run && run.threadId !== threadId)) {
        throw new Error(`question not pending: ${requestId}`)
      }
      waiters.delete(requestId)
      finish(run, runId, requestId)
      deps.append(threadId, runId, "question.answered", { requestId, id: requestId, answers })
      waiter.resolve(answers)
    },
    /** run 结束时取消它还没回答的问题；返回是否取消了一个问题。 */
    cancel(run: ActiveRun, requestId: string): boolean {
      const waiter = waiters.get(requestId)
      if (!waiter) return false
      waiters.delete(requestId)
      deps.pendingRequests.resolve(requestId)
      deps.append(run.threadId, run.runId, "question.answered", {
        requestId,
        id: requestId,
        answers: [],
        reason: "run-ended",
      })
      waiter.resolve([])
      return true
    },
    /** Host 关闭：所有问题以空答案结束。 */
    dispose(): void {
      for (const waiter of waiters.values()) waiter.resolve([])
      waiters.clear()
    },
  }
}
