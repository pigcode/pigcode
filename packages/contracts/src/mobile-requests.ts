import { z } from "zod"

export const mobileRequestMethods = {
  details: "request.details",
  approve: "run.respondApproval",
  answer: "run.answerQuestion",
} as const

export const approvalDecisionSchema = z.enum(["allow-once", "allow-for-session", "deny"])
export const mobileRequestAnswerBytes = 48 * 1024

export const mobileRequestTarget = z.strictObject({
  threadId: z.string().min(1).max(128),
  runId: z.string().min(1).max(128),
  requestId: z.string().min(1).max(128),
})
const commandTarget = mobileRequestTarget.extend({ commandId: z.uuid() })
export const mobileApproveParams = commandTarget.extend({ decision: approvalDecisionSchema })

const questionOption = z.strictObject({
  label: z.string().min(1),
  description: z.string().optional(),
})
const mobileQuestion = z.strictObject({
  header: z.string().optional(),
  question: z.string().min(1),
  options: z.array(questionOption),
  multiSelect: z.boolean(),
  allowCustomAnswer: z.boolean(),
})
const mobileApproval = z.strictObject({
  toolName: z.string().min(1),
  title: z.string().optional(),
  description: z.string().optional(),
  detail: z.string().optional(),
  plan: z.string().optional(),
  decisions: z.array(approvalDecisionSchema),
})
export const mobileRequestDetails = mobileRequestTarget.extend({
  approval: mobileApproval.optional(),
  questions: z.array(mobileQuestion).optional(),
})

const mobileQuestionAnswer = z.strictObject({
  selected: z.array(z.string()),
  custom: z.string().optional(),
})
export const mobileAnswerParams = commandTarget.extend({
  answers: z
    .array(mobileQuestionAnswer)
    .refine(
      (answers) =>
        new TextEncoder().encode(JSON.stringify(answers)).length <= mobileRequestAnswerBytes,
    ),
})

const mobileRequestState = z.enum(["applied", "already-handled", "expired"])
export const mobileRequestOutcome = z.strictObject({
  state: mobileRequestState,
  decision: approvalDecisionSchema.optional(),
  answers: z.array(z.string()).optional(),
  answersTruncated: z.boolean().optional(),
})
const mobileRequestMethod = z.enum([mobileRequestMethods.approve, mobileRequestMethods.answer])
export const mobileRequestReceipt = commandTarget.extend({
  method: mobileRequestMethod,
  outcome: mobileRequestOutcome,
})
const mobileRequestReceiptResult = z.strictObject({ receipt: mobileRequestReceipt.optional() })

export type MobileRequestTarget = z.infer<typeof mobileRequestTarget>
export type MobileApproveParams = z.infer<typeof mobileApproveParams>
export type MobileAnswerParams = z.infer<typeof mobileAnswerParams>
export type MobileRequestDetails = z.infer<typeof mobileRequestDetails>
export type MobileRequestOutcome = z.infer<typeof mobileRequestOutcome>
export type MobileRequestReceipt = z.infer<typeof mobileRequestReceipt>

export function mobileRequestJsonSchemas() {
  const registry = z.registry<{ id: string }>()
  const models = {
    MobileRequestTarget: mobileRequestTarget,
    MobileApproveParams: mobileApproveParams,
    MobileAnswerParams: mobileAnswerParams,
    MobileApproval: mobileApproval,
    MobileApprovalDecision: approvalDecisionSchema,
    MobileQuestionOption: questionOption,
    MobileQuestion: mobileQuestion,
    MobileQuestionAnswer: mobileQuestionAnswer,
    MobileRequestDetails: mobileRequestDetails,
    MobileRequestState: mobileRequestState,
    MobileRequestOutcome: mobileRequestOutcome,
    MobileRequestMethod: mobileRequestMethod,
    MobileRequestReceipt: mobileRequestReceipt,
    MobileRequestReceiptResult: mobileRequestReceiptResult,
  }
  for (const [id, schema] of Object.entries(models)) registry.add(schema, { id })
  return z.toJSONSchema(registry).schemas
}
