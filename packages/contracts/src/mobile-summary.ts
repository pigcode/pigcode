/** 手机端跨电脑汇总协议：单次轻量 RPC 拉取一台电脑的待看计数与优先级队列。 */
import { z } from "zod"
import { pendingRequestSchema, threadStatusSchema } from "./domain"
import { computerIdSchema } from "./mobile"
import { mobileSidebarLabelLimit } from "./mobile-sidebar"

export const mobileSummaryMethods = {
  summary: "mobile.summary",
} as const

export const mobileSummaryMaxItems = 50
export const mobileSummaryPreviewLimit = 120

const nonEmptyStr = z.string().min(1)
const nonNegInt = z.int().nonnegative()
const isoDateTime = z.string().datetime()
const displayLabel = z.string().min(1).max(mobileSidebarLabelLimit)

export const mobileSummaryParamsSchema = z.strictObject({})

export const mobileSummaryCountsSchema = z.strictObject({
  attention: nonNegInt,
  error: nonNegInt,
  unread: nonNegInt,
  working: nonNegInt,
  total: nonNegInt,
})

export const mobileSummaryItemSchema = z.strictObject({
  threadId: nonEmptyStr,
  projectId: nonEmptyStr,
  projectName: displayLabel,
  title: displayLabel,
  updatedAt: isoDateTime,
  status: threadStatusSchema,
  pendingKind: pendingRequestSchema.shape.kind.optional(),
  pendingPreview: z.string().min(1).max(mobileSummaryPreviewLimit).optional(),
  unread: z.boolean(),
  pinned: z.boolean(),
  agentName: displayLabel.optional(),
})

export const mobileComputerSummaryResultSchema = z.strictObject({
  computerId: computerIdSchema,
  computerName: z.string().min(1).max(80),
  syncedAt: isoDateTime,
  counts: mobileSummaryCountsSchema,
  items: z.array(mobileSummaryItemSchema).max(mobileSummaryMaxItems),
  truncated: z.boolean(),
})

export type MobileSummaryMethod =
  (typeof mobileSummaryMethods)[keyof typeof mobileSummaryMethods]
export type MobileSummaryParams = z.infer<typeof mobileSummaryParamsSchema>
export type MobileSummaryCounts = z.infer<typeof mobileSummaryCountsSchema>
export type MobileSummaryItem = z.infer<typeof mobileSummaryItemSchema>
export type MobileComputerSummaryResult = z.infer<typeof mobileComputerSummaryResultSchema>
