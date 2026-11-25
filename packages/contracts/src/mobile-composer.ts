import { z } from "zod"
import { mobileSidebarLabelLimit } from "./mobile-sidebar"
import { runtimeModeSchema } from "./runtime-modes"

export const mobileComposerMethods = {
  switchAgent: "thread.switchAgent",
  setPermissionMode: "thread.setPermissionMode",
  setPlanMode: "thread.setPlanMode",
  composerChanged: "thread.composer",
} as const

const key = z.string().min(1)
const tokenCount = z.int().nonnegative()

export const mobileContextUsage = z.strictObject({
  usedTokens: tokenCount,
  maxTokens: tokenCount.nullable().optional(),
  autoCompactTokens: tokenCount.nullable().optional(),
})

export const mobileThreadComposerState = z.strictObject({
  instanceId: key,
  agentId: key,
  modelId: key.nullable().optional(),
  permissionMode: runtimeModeSchema,
  planMode: z.boolean(),
  supportsPlanMode: z.boolean(),
  supportsImages: z.boolean().optional(),
  contextUsage: mobileContextUsage.nullable().optional(),
})

export const mobileThreadReference = z.strictObject({
  kind: z.literal("thread"),
  threadId: key,
  title: z.string().min(1).max(mobileSidebarLabelLimit),
})

export const mobileThreadReferences = z.array(mobileThreadReference).max(10)

export const mobileSwitchAgentParams = z.strictObject({
  threadId: key,
  instanceId: key,
  modelId: key.nullable().optional(),
})

export const mobileSetPermissionModeParams = z.strictObject({
  threadId: key,
  permissionMode: runtimeModeSchema,
})

export const mobileSetPlanModeParams = z.strictObject({
  threadId: key,
  planMode: z.boolean(),
})

export const mobileComposerChangedNotice = z.strictObject({
  threadId: key,
  composer: mobileThreadComposerState,
})

export type MobileContextUsage = z.infer<typeof mobileContextUsage>
export type MobileThreadComposerState = z.infer<typeof mobileThreadComposerState>
export type MobileThreadReference = z.infer<typeof mobileThreadReference>
export type MobileSwitchAgentParams = z.infer<typeof mobileSwitchAgentParams>
export type MobileSetPermissionModeParams = z.infer<typeof mobileSetPermissionModeParams>
export type MobileSetPlanModeParams = z.infer<typeof mobileSetPlanModeParams>
export type MobileComposerChangedNotice = z.infer<typeof mobileComposerChangedNotice>

export const mobileComposerModels = {
  MobileContextUsage: mobileContextUsage,
  MobileThreadComposerState: mobileThreadComposerState,
  MobileThreadReference: mobileThreadReference,
  MobileSwitchAgentParams: mobileSwitchAgentParams,
  MobileSetPermissionModeParams: mobileSetPermissionModeParams,
  MobileSetPlanModeParams: mobileSetPlanModeParams,
  MobileComposerChangedNotice: mobileComposerChangedNotice,
}

export function mobileComposerJsonSchemas() {
  const registry = z.registry<{ id: string }>()
  for (const [id, schema] of Object.entries(mobileComposerModels)) registry.add(schema, { id })
  return z.toJSONSchema(registry).schemas
}
