import { z } from "zod"
import {
  pendingRequestSchema,
  projectSchema,
  threadReadTargetSchema,
  threadSchema,
  threadStatusSchema,
} from "./domain"
import { computerIdSchema } from "./mobile"
import { rpcErrorSchema } from "./protocol"

export const mobileSidebarWrites = {
  setPinned: "thread.setPinned",
  archive: "thread.archive",
  unarchive: "thread.unarchive",
  markRead: "thread.markRead",
  markAllRead: "thread.markAllRead",
  acknowledgeRead: "thread.acknowledgeRead",
} as const
export type MobileSidebarWrite = (typeof mobileSidebarWrites)[keyof typeof mobileSidebarWrites]

export const mobileSidebarMethods = {
  ...mobileSidebarWrites,
  projectList: "project.list",
  threadList: "thread.list",
  subscribe: "sidebar.subscribe",
  changed: "sidebar.changed",
  status: "mobile.status",
} as const

export const mobileSidebarPageSize = 64
export const mobileSidebarLabelLimit = 512
const displayLabel = z.string().min(1).max(mobileSidebarLabelLimit)

const page = {
  offset: z.int().nonnegative().optional(),
  limit: z.int().min(1).max(mobileSidebarPageSize).optional(),
}

export const mobileProjectListParamsSchema = z.strictObject(page)
export const mobileThreadListParamsSchema = z.strictObject({
  ...page,
  projectId: z.string().min(1).optional(),
})
export const mobileSidebarSubscribeParamsSchema = z.strictObject({})
export const mobileSidebarSubscribeResultSchema = z.strictObject({})
export const mobileSidebarChangedSchema = z.strictObject({})
export const mobileStatusParamsSchema = z.strictObject({})
export const mobileStatusResultSchema = z.strictObject({
  computerId: computerIdSchema,
  computerName: z.string().min(1),
  deviceId: computerIdSchema,
})

export const mobileProjectSummarySchema = projectSchema
  .pick({ id: true, name: true })
  .extend({ name: displayLabel })
  .strict()
export const mobileThreadSummarySchema = threadSchema
  .pick({
    id: true,
    projectId: true,
    title: true,
    updatedAt: true,
    readTarget: true,
    manualUnread: true,
  })
  .extend({
    title: displayLabel,
    archived: z.boolean(),
    pinned: z.boolean(),
    status: threadStatusSchema,
    unread: z.boolean(),
    agentName: displayLabel.optional(),
    pendingKind: pendingRequestSchema.shape.kind.optional(),
  })
  .strict()
export type MobileThreadSummary = z.infer<typeof mobileThreadSummarySchema>

export const mobileProjectListResultSchema = z.array(mobileProjectSummarySchema)
export const mobileThreadListResultSchema = z.array(mobileThreadSummarySchema)

export const mobileRpcErrorSchema = rpcErrorSchema
  .pick({ code: true, message: true, retryable: true })
  .strict()

export const mobileSidebarModels = {
  MobileProjectListParams: mobileProjectListParamsSchema,
  MobileThreadListParams: mobileThreadListParamsSchema,
  MobileSidebarSubscribeParams: mobileSidebarSubscribeParamsSchema,
  MobileSidebarSubscribeResult: mobileSidebarSubscribeResultSchema,
  MobileSidebarChanged: mobileSidebarChangedSchema,
  MobileStatusParams: mobileStatusParamsSchema,
  MobileStatus: mobileStatusResultSchema,
  MobileRpcProblem: mobileRpcErrorSchema,
  MobileProjectSummary: mobileProjectSummarySchema,
  MobileThreadSummary: mobileThreadSummarySchema,
  MobileThreadStatus: threadStatusSchema,
  MobileThreadPendingKind: pendingRequestSchema.shape.kind,
  MobileThreadReadTarget: threadReadTargetSchema,
  MobileProjectList: mobileProjectListResultSchema,
  MobileThreadList: mobileThreadListResultSchema,
}

/** Export references so the Dart generator uses the same nested types as Host. */
export function mobileSidebarJsonSchemas() {
  const registry = z.registry<{ id: string }>()
  for (const [id, schema] of Object.entries(mobileSidebarModels)) registry.add(schema, { id })
  return z.toJSONSchema(registry).schemas
}
