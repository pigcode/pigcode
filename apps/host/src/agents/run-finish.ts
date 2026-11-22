import type { PendingRequest, ThreadEvent } from "@pigcode/contracts"
import type { Context } from "cordis"
import type { PendingRequestStore } from "../storage/pending-request-store"
import type { RunStore } from "../storage/run-store"
import type { ActiveRun } from "./run-queue"

interface FinishDeps {
  ctx: Context
  runs: RunStore
  pendingRequests: PendingRequestStore
  activeRuns: Map<string, ActiveRun>
  activeThreads: Set<string>
  append(threadId: string, runId: string, type: ThreadEvent["type"], payload: unknown): void
  releaseRequest(request: PendingRequest): void
  pump(): void
}

/** 先提交终态、事件和可选回执，再释放 Agent 与订阅者。 */
export function createRunFinisher(deps: FinishDeps) {
  return function finishRun(
    run: ActiveRun,
    status: "completed" | "failed" | "interrupted",
    type: "run.completed" | "run.failed" | "run.interrupted",
    payload: unknown,
    error?: { code: string; message: string },
    recordReceipt?: () => void,
  ): void {
    const { runId, threadId } = run
    if (deps.activeRuns.get(runId) !== run) return
    const pending = deps.pendingRequests
      .listPending(threadId)
      .filter((item) => item.runId === runId)
    const publish = deps.ctx.sessions.stageEvents(() => {
      recordReceipt?.()
      deps.runs.setStatus(runId, status, error)
      for (const { id, kind } of pending) {
        deps.pendingRequests.resolve(id)
        deps.append(
          threadId,
          runId,
          kind === "question" ? "question.answered" : "approval.resolved",
          {
            requestId: id,
            id,
            reason: "run-ended",
            ...(kind === "question" ? { answers: [] } : { decision: "deny" }),
          },
        )
      }
      if (status !== "completed" && run.liveText.trim()) {
        deps.append(threadId, runId, "message.completed", {
          role: "assistant",
          text: run.liveText,
          partial: true,
        })
      }
      deps.append(threadId, runId, type, payload)
    })
    run.status = status
    run.liveText = ""
    deps.activeRuns.delete(runId)
    deps.activeThreads.delete(threadId)
    for (const request of pending) deps.releaseRequest(request)
    run.approvals.clear()
    if (status === "interrupted") {
      run.controller.abort()
      run.interruption = Promise.resolve()
        .then(() => run.driver.interrupt(run.session))
        .catch(() => undefined)
    }
    publish()
    run.resolveDone()
    deps.pump()
  }
}
