import {
  approvalDecisionSchema,
  type MobileRequestOutcome,
  type MobileRequestTarget,
  type RunStatus,
  type ThreadEvent,
} from "@pigcode/contracts"
import type { Context } from "cordis"
import type { PendingRequestStore } from "../storage/pending-request-store"
import type { RunStore } from "../storage/run-store"
import type { ApprovalBridge } from "./approval-bridge"
import type { AgentQuestion, ApprovalDecision, ApprovalRequest, QuestionRequest } from "./driver"
import type { createQuestionFlow } from "./questions"
import type { ActiveRun } from "./run-queue"

export interface RequestHandlingOptions {
  source: string
  recordReceipt: (outcome: MobileRequestOutcome) => void
}

type Response =
  { kind: "approval"; decision: ApprovalDecision } | { kind: "question"; answers: string[] }

export class RunRequestError extends Error {
  constructor(
    readonly code: "RESOURCE_NOT_AVAILABLE" | "INVALID_PARAMS",
    message: string,
  ) {
    super(message)
  }
}

export function approvalDecisions(payload: ApprovalRequest): ApprovalDecision[] {
  const choices = approvalDecisionSchema.array().safeParse(payload.decisions)
  const decisions = choices.success ? choices.data : [...approvalDecisionSchema.options]
  return payload.toolName === "ExitPlanMode"
    ? decisions.filter((decision) => decision !== "allow-for-session")
    : decisions
}

function isOfferedAnswer(question: AgentQuestion, answer: string): boolean {
  if (!answer.trim()) return false
  if (question.allowCustomAnswer !== false) return true
  const labels = question.options.map(({ label }) => label)
  if (labels.includes(answer)) return true
  if (!question.multiSelect) return false

  // Desktop answers are comma-separated, and an individual option may also contain a comma.
  const offsets = new Set([0])
  for (const offset of offsets) {
    for (const label of labels) {
      if (!label || !answer.startsWith(label, offset)) continue
      const end = offset + label.length
      if (end === answer.length) return true
      if (answer.startsWith(", ", end)) offsets.add(end + 2)
    }
  }
  return false
}

interface RequestDeps {
  ctx: Context
  runs: RunStore
  activeRuns: Map<string, ActiveRun>
  pendingRequests: PendingRequestStore
  approvals: ApprovalBridge
  questions: ReturnType<typeof createQuestionFlow>
  append(threadId: string, runId: string, type: ThreadEvent["type"], payload: unknown): void
}

/** 两端共用一次受理流程。落盘完成后才允许 Agent 继续。 */
export function createRunRequestResponder(deps: RequestDeps) {
  return function respond(
    { threadId, runId, requestId }: MobileRequestTarget,
    response: Response,
    options?: RequestHandlingOptions,
  ): MobileRequestOutcome {
    const entry = deps.pendingRequests.get(requestId)
    if (
      !entry ||
      entry.threadId !== threadId ||
      entry.runId !== runId ||
      entry.kind !== response.kind
    ) {
      throw new RunRequestError(
        "RESOURCE_NOT_AVAILABLE",
        `${response.kind} not pending: ${requestId}`,
      )
    }
    const waiting =
      response.kind === "approval" ? deps.approvals.has(requestId) : deps.questions.has(requestId)
    if (entry.status !== "pending" || !waiting) {
      const result =
        entry.resolution ??
        (entry.status === "resolved" ? deps.pendingRequests.legacyResolution(entry) : undefined)
      const outcome: MobileRequestOutcome = result
        ? {
            state: "already-handled",
            ...(result.decision ? { decision: result.decision } : { answers: result.answers }),
          }
        : { state: "expired" }
      options?.recordReceipt(outcome)
      return outcome
    }

    if (response.kind === "approval") {
      if (!approvalDecisions(entry.payload as ApprovalRequest).includes(response.decision)) {
        throw new RunRequestError("INVALID_PARAMS", "approval decision is unavailable")
      }
    } else {
      const { questions } = entry.payload as QuestionRequest
      if (
        response.answers.length !== questions.length ||
        response.answers.some((answer, index) => !isOfferedAnswer(questions[index]!, answer))
      ) {
        throw new RunRequestError("INVALID_PARAMS", "answer each question before submitting")
      }
    }

    const value =
      response.kind === "approval" ? { decision: response.decision } : { answers: response.answers }
    const outcome: MobileRequestOutcome = { state: "applied", ...value }
    let status: RunStatus = "running"
    const publish = deps.ctx.sessions.stageEvents(() => {
      if (
        !deps.pendingRequests.resolve(requestId, { ...value, source: options?.source ?? "desktop" })
      ) {
        throw new Error("pending request changed before it could be resolved")
      }
      const remaining = deps.pendingRequests
        .listPending(threadId)
        .find((item) => item.runId === runId)
      if (remaining) status = remaining.kind === "approval" ? "waiting-approval" : "waiting-input"
      deps.runs.setStatus(runId, status)
      deps.append(
        threadId,
        runId,
        response.kind === "approval" ? "approval.resolved" : "question.answered",
        { requestId, id: requestId, ...value },
      )
      options?.recordReceipt(outcome)
    })
    const run = deps.activeRuns.get(runId)
    if (run) {
      run.status = status
      run.approvals.delete(requestId)
    }
    if (response.kind === "approval") deps.approvals.resolve(requestId, response.decision)
    else deps.questions.resolve(requestId, response.answers)
    publish()
    return outcome
  }
}
