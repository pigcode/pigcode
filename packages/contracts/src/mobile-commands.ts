import { z } from "zod"
import { attachmentIdsSchema } from "./attachments"
import { reasoningEffortSchema } from "./domain"
import { mobileThreadReference, mobileThreadReferences } from "./mobile-composer"

export const mobileCommandMethods = {
  start: "run.start",
  interrupt: "run.interrupt",
  receipt: "command.receipt",
} as const

// Keep the JSON request within one Noise frame even when text needs JSON escaping.
export const mobileCommandTextLimit = 10_000
const commandId = z.uuid()
const threadId = z.string().min(1)
const runId = z.string().min(1)

export const legacyMobileStartRunParams = z.strictObject({
  commandId,
  threadId,
  text: z.string().min(1).max(mobileCommandTextLimit).regex(/\S/),
})
export const mobileStartRunParams = z
  .strictObject({
    commandId,
    threadId,
    text: z.string().max(mobileCommandTextLimit),
    effort: reasoningEffortSchema.optional(),
    fast: z.boolean().optional(),
    ultracode: z.boolean().optional(),
    references: mobileThreadReferences.optional(),
    attachmentIds: attachmentIdsSchema.optional(),
  })
  .refine((value) => /\S/.test(value.text) || (value.attachmentIds?.length ?? 0) > 0, {
    message: "text or attachmentIds is required",
  })
export const mobileInterruptRunParams = z.strictObject({ commandId, threadId, runId })
export const mobileReceiptParams = z.strictObject({ commandId })

const mobileRunMethod = z.enum([mobileCommandMethods.start, mobileCommandMethods.interrupt])
export const mobileRunReceipt = z.strictObject({
  commandId,
  method: mobileRunMethod,
  threadId,
  runId,
  queuedMessageId: z.string().optional(),
})
export const mobileReceiptResult = z.strictObject({ receipt: mobileRunReceipt.optional() })

export type MobileStartRunParams = z.infer<typeof mobileStartRunParams>
export type MobileInterruptRunParams = z.infer<typeof mobileInterruptRunParams>
export type MobileRunReceipt = z.infer<typeof mobileRunReceipt>

const models = {
  MobileThreadReference: mobileThreadReference,
  MobileStartRunParams: mobileStartRunParams,
  MobileInterruptRunParams: mobileInterruptRunParams,
  MobileReceiptParams: mobileReceiptParams,
  MobileRunMethod: mobileRunMethod,
  MobileRunReceipt: mobileRunReceipt,
  MobileReceiptResult: mobileReceiptResult,
}

export function mobileCommandJsonSchemas() {
  const registry = z.registry<{ id: string }>()
  for (const [id, schema] of Object.entries(models)) registry.add(schema, { id })
  return z.toJSONSchema(registry).schemas
}
