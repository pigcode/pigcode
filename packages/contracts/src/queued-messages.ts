import { z } from "zod"

export const queueMethods = {
  get: "queue.get",
  withdraw: "queue.withdraw",
  stopAndSend: "queue.stopAndSend",
  resume: "queue.resume",
} as const

const id = z.string().min(1).max(128)
export const queueThreadParams = z.strictObject({ threadId: id })
export const queueResumeParams = queueThreadParams.extend({ commandId: z.uuid() })
export const queueWithdrawParams = queueResumeParams.extend({ messageId: id })
export const queueStopAndSendParams = queueWithdrawParams.extend({ runId: id })

export const queuedMessageCommands = {
  [queueMethods.get]: queueThreadParams,
  [queueMethods.withdraw]: queueWithdrawParams,
  [queueMethods.stopAndSend]: queueStopAndSendParams,
  [queueMethods.resume]: queueResumeParams,
} as const

const queuedMessage = z.strictObject({
  id,
  text: z.string(),
  selected: z.boolean(),
})
export const queuedMessagesSnapshot = queueThreadParams.extend({
  paused: z.boolean(),
  activeRunId: id.optional(),
  messages: z.array(queuedMessage),
})

const queueMethod = z.enum([queueMethods.withdraw, queueMethods.stopAndSend, queueMethods.resume])
const queueEffect = z.enum(["withdrawn", "scheduled", "resumed", "unchanged"])
export const queueReceipt = queueResumeParams.extend({
  method: queueMethod,
  effect: queueEffect,
  messageId: id.optional(),
  runId: id.optional(),
  stoppedRunId: id.optional(),
  text: z.string().optional(),
})
const queueReceiptResult = z.strictObject({ receipt: queueReceipt.optional() })

export type QueueSnapshot = z.infer<typeof queuedMessagesSnapshot>
export type QueueReceipt = z.infer<typeof queueReceipt>
export type QueueWithdrawParams = z.infer<typeof queueWithdrawParams>
export type QueueStopAndSendParams = z.infer<typeof queueStopAndSendParams>
export type QueueResumeParams = z.infer<typeof queueResumeParams>

export function mobileQueueJsonSchemas() {
  const registry = z.registry<{ id: string }>()
  const models = {
    QueueThreadParams: queueThreadParams,
    QueueWithdrawParams: queueWithdrawParams,
    QueueStopAndSendParams: queueStopAndSendParams,
    QueueResumeParams: queueResumeParams,
    QueuedMessage: queuedMessage,
    QueueSnapshot: queuedMessagesSnapshot,
    QueueMethod: queueMethod,
    QueueEffect: queueEffect,
    QueueReceipt: queueReceipt,
    QueueReceiptResult: queueReceiptResult,
  }
  for (const [name, model] of Object.entries(models)) registry.add(model, { id: name })
  return z.toJSONSchema(registry).schemas
}
