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

  function resolve(requestId: string, answers: string[]): void {
    const waiter = waiters.get(requestId)
    if (!waiter) return
    waiters.delete(requestId)
    waiter.resolve(answers)
  }

  function withdraw(run: ActiveRun, requestId: string): void {
    if (!waiters.has(requestId)) return
    finish(run, run.runId, requestId)
    deps.append(run.threadId, run.runId, "question.answered", {
      requestId,
      id: requestId,
      answers: [],
      reason: "agent-cancelled",
    })
    resolve(requestId, [])
  }

  return {
    /** 发起提问，返回每个问题的答案（与问题顺序一致）。 */
    ask(run: ActiveRun, request: QuestionRequest, signal?: AbortSignal): Promise<string[]> {
      if (signal?.aborted) return Promise.resolve([])
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
      deps.runs.setStatus(run.runId, "waiting-input")
      run.status = "waiting-input"
      run.approvals.add(requestId)
      const done = new Promise<string[]>((resolve) =>
        waiters.set(requestId, { runId: run.runId, resolve }),
      )
      const abort = () => withdraw(run, requestId)
      signal?.addEventListener("abort", abort, { once: true })
      deps.append(run.threadId, run.runId, "question.requested", {
        requestId,
        id: requestId,
        questions: request.questions,
      })
      return done.finally(() => signal?.removeEventListener("abort", abort))
    },
    has: (requestId: string) => waiters.has(requestId),
    /** 已持久化结果后通知等待中的 Agent。 */
    resolve,

    /** Host 关闭：所有问题以空答案结束。 */
    dispose(): void {
      for (const waiter of waiters.values()) waiter.resolve([])
      waiters.clear()
    },
  }
}
