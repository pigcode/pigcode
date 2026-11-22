import { z } from "zod"

export const timelinePageBytes = 256 * 1024
export const timelineToolPreviewLength = 512
export const timelineTextPreviewLength = 8 * 1024

export const mobileTimelineMethods = {
  subscribe: "thread.subscribe",
  unsubscribe: "thread.unsubscribe",
  history: "thread.history",
  content: "thread.content",
  live: "thread.live",
  event: "thread.event",
  delta: "thread.delta",
} as const

const threadId = z.string().min(1)
const runId = z.string().min(1)
const sequence = z.int().nonnegative()

export const mobileTimelineThreadParams = z.strictObject({ threadId })
export const mobileTimelineHistoryParams = z.strictObject({
  threadId,
  through: sequence,
  before: z.int().positive(),
})
const mobileTimelineContentField = z.enum(["text", "input", "output", "reasoning"])
export const mobileTimelineContentParams = z.strictObject({
  threadId,
  seq: z.int().positive().optional(),
  runId: runId.optional(),
  toolId: z.string().min(1).optional(),
  field: mobileTimelineContentField,
  offset: sequence.optional(),
})

const mobileTimelineKind = z.enum([
  "run.queued",
  "run.started",
  "run.completed",
  "run.failed",
  "run.interrupted",
  "message.user",
  "message.assistant",
  "reasoning",
  "tool.started",
  "tool.completed",
  "file",
  "plan",
  "notice",
  "approval.requested",
  "approval.resolved",
  "question.requested",
  "question.answered",
])

export const mobileTimelineEvent = z.strictObject({
  seq: sequence,
  runId: runId.optional(),
  kind: mobileTimelineKind,
  createdAt: z.iso.datetime(),
  text: z.string().optional(),
  truncated: z.boolean().optional(),
  itemId: z.string().optional(),
  name: z.string().optional(),
  failed: z.boolean().optional(),
  finishedSteps: sequence.optional(),
  totalSteps: sequence.optional(),
})

const mobileTimelineToolPreview = z.strictObject({
  id: z.string().min(1),
  text: z.string(),
  truncated: z.boolean(),
})
const mobileTimelinePendingKind = z.enum(["approval", "question"])
export const mobileTimelinePending = z.strictObject({
  id: z.string().min(1),
  kind: mobileTimelinePendingKind,
})
export const mobileActiveRun = z.strictObject({
  runId,
  startedAt: z.iso.datetime(),
  revision: sequence,
  text: z.string(),
  textTruncated: z.boolean(),
  reasoning: z.string(),
  reasoningTruncated: z.boolean(),
  tools: z.array(mobileTimelineToolPreview),
  pending: z.array(mobileTimelinePending),
  step: z.string().optional(),
  finishedSteps: sequence.optional(),
  totalSteps: sequence.optional(),
})

export const mobileTimelinePage = z.strictObject({
  events: z.array(mobileTimelineEvent),
  through: sequence,
  nextBefore: z.int().positive().optional(),
})
export const mobileTimelineSubscription = z.strictObject({
  page: mobileTimelinePage,
  live: mobileActiveRun.optional(),
})
export const mobileTimelineLiveResult = z.strictObject({
  live: mobileActiveRun.optional(),
  through: sequence,
})
export const mobileTimelineUnsubscribed = z.strictObject({ ok: z.boolean() })
export const mobileTimelineContentResult = z.strictObject({
  text: z.string(),
  nextOffset: sequence.optional(),
})
export const mobileTimelineNotice = z.strictObject({
  threadId,
  previousSeq: sequence,
  event: mobileTimelineEvent,
})

const mobileRunDeltaKind = z.enum(["text", "reasoning", "tool"])
export const mobileRunDelta = z.strictObject({
  threadId,
  runId,
  revision: z.int().positive(),
  kind: mobileRunDeltaKind,
  text: z.string(),
  truncated: z.boolean().optional(),
  toolId: z.string().optional(),
})

export type MobileTimelineEvent = z.infer<typeof mobileTimelineEvent>
export type MobileTimelinePage = z.infer<typeof mobileTimelinePage>
export type MobileTimelineContentParams = z.infer<typeof mobileTimelineContentParams>
export type MobileActiveRun = z.infer<typeof mobileActiveRun>

export const mobileTimelineModels = {
  MobileTimelineThreadParams: mobileTimelineThreadParams,
  MobileTimelineHistoryParams: mobileTimelineHistoryParams,
  MobileTimelineContentParams: mobileTimelineContentParams,
  MobileTimelineContentField: mobileTimelineContentField,
  MobileTimelineKind: mobileTimelineKind,
  MobileTimelineEvent: mobileTimelineEvent,
  MobileTimelineToolPreview: mobileTimelineToolPreview,
  MobileTimelinePendingKind: mobileTimelinePendingKind,
  MobileTimelinePending: mobileTimelinePending,
  MobileActiveRun: mobileActiveRun,
  MobileTimelinePage: mobileTimelinePage,
  MobileTimelineSubscription: mobileTimelineSubscription,
  MobileTimelineLiveResult: mobileTimelineLiveResult,
  MobileTimelineUnsubscribed: mobileTimelineUnsubscribed,
  MobileTimelineContentResult: mobileTimelineContentResult,
  MobileTimelineNotice: mobileTimelineNotice,
  MobileRunDeltaKind: mobileRunDeltaKind,
  MobileRunDelta: mobileRunDelta,
}

export function mobileTimelineJsonSchemas() {
  const registry = z.registry<{ id: string }>()
  for (const [id, schema] of Object.entries(mobileTimelineModels)) registry.add(schema, { id })
  return z.toJSONSchema(registry).schemas
}
