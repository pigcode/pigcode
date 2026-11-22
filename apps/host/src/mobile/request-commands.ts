import {
  mobileAnswerParams,
  mobileApproveParams,
  mobileRequestDetails,
  mobileRequestMethods as methods,
  mobileRequestReceipt,
  mobileRequestTarget,
  type MobileAnswerParams,
  type MobileApproveParams,
  type MobileRequestDetails,
  type MobileRequestOutcome,
  type MobileRequestReceipt,
  type MobileRequestTarget,
  type PendingRequest,
  type RpcRequest,
} from "@pigcode/contracts"
import type { Context } from "cordis"
import type { ApprovalRequest, AgentQuestion, QuestionRequest } from "../agents/driver"
import { approvalDecisions, RunRequestError } from "../agents/run-requests"
import { PendingRequestStore } from "../storage/pending-request-store"
import { commandBinding, requireMobileThread, type MobileCommandReceipts } from "./command-receipts"
import { mobileParams, MobileRequestError } from "./request-error"

export const mobileRequestCommands: ReadonlySet<string> = new Set(Object.values(methods))

function questionAnswers(
  questions: AgentQuestion[],
  answers: MobileAnswerParams["answers"],
): string[] {
  if (questions.length !== answers.length) throw new MobileRequestError("INVALID_PARAMS")
  return questions.map((question, index) => {
    const { selected, custom } = answers[index]!
    const extra = custom?.trim() ?? ""
    if (
      (!question.multiSelect && selected.length + Number(!!extra) > 1) ||
      new Set(selected).size !== selected.length ||
      selected.some((label) => !question.options.some((option) => option.label === label)) ||
      (extra && question.allowCustomAnswer === false) ||
      (!selected.length && !extra)
    ) {
      throw new MobileRequestError("INVALID_PARAMS")
    }
    return extra ? [...selected, extra].join(", ") : selected.join(", ")
  })
}

function displayOutcome(outcome: MobileRequestOutcome): MobileRequestOutcome {
  const answers = outcome.answers
  if (!answers || Buffer.byteLength(JSON.stringify(answers)) <= 96 * 1024) return outcome
  return {
    ...outcome,
    answers: answers
      .slice(0, 32)
      .map((answer) => answer.slice(0, 350).replace(/[\uD800-\uDBFF]$/, "")),
    answersTruncated: true,
  }
}

export class MobileRequestCommands {
  private readonly requests: PendingRequestStore

  constructor(
    private readonly ctx: Context,
    private readonly receipts: MobileCommandReceipts,
    private readonly source: string,
  ) {
    this.requests = new PendingRequestStore(ctx.storage.db)
  }

  dispatch(request: RpcRequest): unknown {
    try {
      switch (request.method) {
        case methods.details: {
          const target = mobileParams(mobileRequestTarget, request.params)
          requireMobileThread(this.ctx, target.threadId)
          return this.details(target, this.find(target))
        }
        case methods.approve:
          return this.handle(methods.approve, mobileParams(mobileApproveParams, request.params))
        case methods.answer:
          return this.handle(methods.answer, mobileParams(mobileAnswerParams, request.params))
        default:
          throw new MobileRequestError("METHOD_NOT_AVAILABLE")
      }
    } catch (error) {
      if (error instanceof RunRequestError) throw new MobileRequestError(error.code)
      throw error
    }
  }

  private find(target: MobileRequestTarget): PendingRequest {
    const entry = this.requests.get(target.requestId)
    if (!entry || entry.threadId !== target.threadId || entry.runId !== target.runId) {
      throw new MobileRequestError("RESOURCE_NOT_AVAILABLE")
    }
    return entry
  }

  private details(target: MobileRequestTarget, entry: PendingRequest): MobileRequestDetails {
    if (entry.status !== "pending") throw new MobileRequestError("RESOURCE_NOT_AVAILABLE")
    let result: MobileRequestDetails
    if (entry.kind === "approval") {
      const approval = entry.payload as ApprovalRequest
      const input = approval.input as { command?: unknown; plan?: unknown } | undefined
      const plan =
        approval.toolName === "ExitPlanMode" && typeof input?.plan === "string"
          ? input.plan
          : undefined
      const detail =
        typeof input?.command === "string" ? input.command : JSON.stringify(approval.input, null, 2)
      result = {
        ...target,
        approval: {
          toolName: approval.toolName,
          title: approval.title ?? approval.displayName,
          description: approval.description ?? approval.blockedPath,
          detail: plan ? undefined : detail,
          plan,
          decisions: approvalDecisions(approval),
        },
      }
    } else {
      const { questions } = entry.payload as QuestionRequest
      result = {
        ...target,
        questions: questions.map(
          ({ question, header, options, multiSelect, allowCustomAnswer }) => ({
            question,
            header,
            multiSelect,
            allowCustomAnswer: allowCustomAnswer !== false,
            options: options.map(({ label, description }) => ({ label, description })),
          }),
        ),
      }
    }
    if (Buffer.byteLength(JSON.stringify(result)) > 96 * 1024) {
      throw new MobileRequestError("RESULT_TOO_LARGE")
    }
    return mobileRequestDetails.parse(result)
  }

  private handle(
    method: MobileRequestReceipt["method"],
    params: MobileApproveParams | MobileAnswerParams,
  ): MobileRequestReceipt {
    const { threadId, runId, requestId, commandId } = params
    const target = { threadId, runId, requestId }
    requireMobileThread(this.ctx, threadId)
    const isApproval = "decision" in params
    const argument = isApproval ? params.decision : params.answers
    const binding = commandBinding(method, threadId, runId, requestId, argument)
    const previous = this.receipts.existing(commandId, binding, mobileRequestReceipt)
    if (previous) return previous
    const entry = this.find(target)
    if (entry.kind !== (isApproval ? "approval" : "question")) {
      throw new MobileRequestError("RESOURCE_NOT_AVAILABLE")
    }
    if (entry.status === "pending") this.details(target, entry)
    const direct = (outcome: MobileRequestOutcome) => ({
      ...target,
      method,
      commandId,
      outcome: displayOutcome(outcome),
    })
    const options = {
      source: this.source,
      recordReceipt: (outcome: MobileRequestOutcome) =>
        this.receipts.record(direct(outcome), binding),
    }
    const outcome = isApproval
      ? this.ctx.agents.respondApproval(threadId, runId, requestId, params.decision, options)
      : this.ctx.agents.answerQuestion(
          threadId,
          runId,
          requestId,
          entry.status === "pending"
            ? questionAnswers((entry.payload as QuestionRequest).questions, params.answers)
            : [],
          options,
        )
    return direct(outcome)
  }
}
