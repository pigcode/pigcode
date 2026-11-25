import { z } from "zod"
import { reasoningEffortSchema } from "./domain"
import { mobileCommandTextLimit } from "./mobile-commands"
import { mobileThreadReference, mobileThreadReferences } from "./mobile-composer"
import { runtimeModeSchema } from "./runtime-modes"

export const mobileDraftMethods = {
  options: "thread.draftOptions",
  models: "thread.draftModels",
  create: "thread.create",
} as const

const key = z.string().min(1)
const accentColor = z.string().regex(/^#[\da-f]{6}$/i)
export const mobileDraftOptionsParams = z.strictObject({})
export const mobileDraftModelParams = z.strictObject({ instanceId: key })
export const legacyMobileDraftCreateParams = mobileDraftModelParams.extend({
  commandId: z.uuid(),
  projectId: key,
  modelId: key.optional(),
  permissionMode: runtimeModeSchema,
  text: z.string().min(1).max(mobileCommandTextLimit).regex(/\S/),
})
export const mobileDraftCreateParams = legacyMobileDraftCreateParams.extend({
  effort: reasoningEffortSchema.optional(),
  fast: z.boolean().optional(),
  ultracode: z.boolean().optional(),
  planMode: z.boolean().optional(),
  references: mobileThreadReferences.optional(),
})

const instanceOption = z.strictObject({
  instanceId: key,
  label: key,
  agentName: key,
  permissionModes: z.array(runtimeModeSchema).min(1),
  defaultPermissionMode: runtimeModeSchema,
  agentId: key.optional(),
  accentColor: accentColor.optional(),
  supportsPlanMode: z.boolean().optional(),
})
export const mobileDraftOptions = z.strictObject({
  instances: z.array(instanceOption),
  defaultInstanceId: key.optional(),
})
const modelOption = z.strictObject({
  id: key,
  label: key,
  efforts: z.array(reasoningEffortSchema).optional(),
  fast: z.boolean().optional(),
  ultracode: z.boolean().optional(),
})
export const mobileDraftModels = z.strictObject({
  models: z.array(modelOption),
  defaultModelId: key.optional(),
})
export const mobileDraftReceipt = z.strictObject({
  method: z.literal(mobileDraftMethods.create),
  commandId: z.uuid(),
  projectId: key,
  threadId: key,
  title: key,
  runId: key,
})
const mobileDraftReceiptResult = z.strictObject({ receipt: mobileDraftReceipt.optional() })

export type MobileDraftCreateParams = z.infer<typeof mobileDraftCreateParams>
export type MobileDraftInstance = z.infer<typeof instanceOption>
export type MobileDraftModel = z.infer<typeof modelOption>
export type MobileDraftModels = z.infer<typeof mobileDraftModels>
export type MobileDraftReceipt = z.infer<typeof mobileDraftReceipt>

export function mobileDraftJsonSchemas() {
  const registry = z.registry<{ id: string }>()
  const models = {
    MobileDraftPermission: runtimeModeSchema,
    MobileThreadReference: mobileThreadReference,
    MobileDraftModelParams: mobileDraftModelParams,
    MobileDraftCreateParams: mobileDraftCreateParams,
    MobileDraftInstance: instanceOption,
    MobileDraftOptions: mobileDraftOptions,
    MobileDraftModel: modelOption,
    MobileDraftModels: mobileDraftModels,
    MobileDraftReceipt: mobileDraftReceipt,
    MobileDraftReceiptResult: mobileDraftReceiptResult,
  }
  for (const [id, schema] of Object.entries(models)) registry.add(schema, { id })
  return z.toJSONSchema(registry).schemas
}
