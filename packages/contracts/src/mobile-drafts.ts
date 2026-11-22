import { z } from "zod"
import { mobileCommandTextLimit } from "./mobile-commands"
import { runtimeModeSchema } from "./runtime-modes"

export const mobileDraftMethods = {
  options: "thread.draftOptions",
  models: "thread.draftModels",
  create: "thread.create",
} as const

const key = z.string().min(1)
export const mobileDraftOptionsParams = z.strictObject({})
export const mobileDraftModelParams = z.strictObject({ instanceId: key })
export const mobileDraftCreateParams = mobileDraftModelParams.extend({
  commandId: z.uuid(),
  projectId: key,
  modelId: key.optional(),
  permissionMode: runtimeModeSchema,
  text: z.string().min(1).max(mobileCommandTextLimit).regex(/\S/),
})

const instanceOption = z.strictObject({
  instanceId: key,
  label: key,
  agentName: key,
  permissionModes: z.array(runtimeModeSchema).min(1),
  defaultPermissionMode: runtimeModeSchema,
})
export const mobileDraftOptions = z.strictObject({
  instances: z.array(instanceOption),
  defaultInstanceId: key.optional(),
})
const modelOption = z.strictObject({ id: key, label: key })
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
export type MobileDraftModels = z.infer<typeof mobileDraftModels>
export type MobileDraftReceipt = z.infer<typeof mobileDraftReceipt>

export function mobileDraftJsonSchemas() {
  const registry = z.registry<{ id: string }>()
  const models = {
    MobileDraftPermission: runtimeModeSchema,
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
