/** 手机端 Agent 实例管理协议：查看列表与检测状态、默认实例设置、实例 CRUD 与模型偏好管理。 */
import { z } from "zod"
import {
  agentAccentColorSchema,
  agentInstancePatchSchema,
  agentSettingFieldSchema,
  agentSettingsValuesSchema,
  customAgentInstanceIdSchema,
  localizedTextSchema,
} from "./agents"

export const mobileAgentMethods = {
  list: "mobile.agent.list",
  detect: "mobile.agent.detect",
  models: "mobile.agent.models",
  setDefault: "mobile.agent.setDefault",
  createInstance: "mobile.agent.createInstance",
  updateInstance: "mobile.agent.updateInstance",
  removeInstance: "mobile.agent.removeInstance",
} as const

const key = z.string().min(1).max(128)

/** 裁剪后的手机端检测状态：不暴露电脑本机可执行文件绝对路径 command。 */
export const mobileAgentStatusSchema = z
  .object({
    installed: z.boolean(),
    version: z.string().nullable(),
    authenticated: z.boolean().nullable(),
    usingCliLogin: z.boolean().optional(),
    credentialsConfigured: z.boolean().optional(),
    account: z.string().nullable().optional(),
    email: z.string().nullable().optional(),
    error: z.string().nullable().optional(),
  })
  .strict()

export const mobileAgentInstanceSchema = z
  .object({
    instanceId: key,
    agentId: key,
    label: z.string().min(1).max(120),
    accentColor: agentAccentColorSchema.optional(),
    enabled: z.boolean(),
    isDefault: z.boolean(),
    values: agentSettingsValuesSchema,
  })
  .strict()

export const mobileAgentSummarySchema = z
  .object({
    agentId: key,
    displayName: z.string().min(1).max(120),
    pluginId: key.nullable(),
    version: z.string().max(64).nullable(),
    builtin: z.boolean(),
    enabled: z.boolean(),
    registered: z.boolean(),
    requiresInstance: z.boolean(),
    acpRegistry: z.boolean(),
    accountSetup: z.boolean(),
    secretReferences: z.boolean(),
    customModels: z.boolean(),
    description: localizedTextSchema.nullable(),
    fields: z.array(agentSettingFieldSchema),
    error: z.string().max(1024).nullable(),
    instances: z.array(mobileAgentInstanceSchema),
  })
  .strict()

export const mobileAgentModelItemSchema = z
  .object({
    id: z.string().min(1).max(256),
    name: z.string().min(1).max(256),
    isCustom: z.boolean(),
    hidden: z.boolean(),
  })
  .strict()

export const mobileAgentListParams = z.object({}).strict()
export const mobileAgentListResult = z
  .object({
    defaultAgentId: key.nullable(),
    defaultInstanceId: key.nullable(),
    agents: z.array(mobileAgentSummarySchema),
  })
  .strict()

export const mobileAgentDetectParams = z
  .object({
    agentId: key.optional(),
    instanceId: key.optional(),
    refresh: z.boolean().optional(),
  })
  .strict()
export const mobileAgentDetectResult = z
  .object({
    statuses: z.record(key, mobileAgentStatusSchema),
  })
  .strict()

export const mobileAgentModelsParams = z
  .object({
    agentId: key.optional(),
    instanceId: key.optional(),
  })
  .strict()
  .refine((value) => value.agentId !== undefined || value.instanceId !== undefined, {
    message: "agentId or instanceId is required",
  })
export const mobileAgentModelsResult = z
  .object({
    models: z.array(mobileAgentModelItemSchema),
  })
  .strict()

export const mobileAgentSetDefaultParams = z
  .object({
    agentId: key.nullable(),
    instanceId: key.nullable().optional(),
  })
  .strict()
export const mobileAgentSetDefaultResult = z
  .object({
    defaultAgentId: key.nullable(),
    defaultInstanceId: key.nullable(),
  })
  .strict()

export const mobileAgentCreateInstanceParams = z
  .object({
    agentId: key,
    label: z.string().trim().max(120).default(""),
    instanceId: customAgentInstanceIdSchema.optional(),
    accentColor: agentAccentColorSchema.optional(),
    values: agentSettingsValuesSchema.optional(),
    copyFrom: key.optional(),
  })
  .strict()
export const mobileAgentCreateInstanceResult = z
  .object({
    instance: mobileAgentInstanceSchema,
  })
  .strict()

export const mobileAgentUpdateInstanceParams = z
  .object({
    instanceId: key,
    patch: agentInstancePatchSchema.strict(),
  })
  .strict()
export const mobileAgentUpdateInstanceResult = z
  .object({
    instance: mobileAgentInstanceSchema,
  })
  .strict()

export const mobileAgentRemoveInstanceParams = z
  .object({
    instanceId: key,
  })
  .strict()
export const mobileAgentRemoveInstanceResult = z
  .object({
    removed: z.literal(true),
    instanceId: key,
  })
  .strict()

export type MobileAgentMethod = (typeof mobileAgentMethods)[keyof typeof mobileAgentMethods]
export type MobileAgentStatus = z.infer<typeof mobileAgentStatusSchema>
export type MobileAgentInstance = z.infer<typeof mobileAgentInstanceSchema>
export type MobileAgentSummary = z.infer<typeof mobileAgentSummarySchema>
export type MobileAgentModelItem = z.infer<typeof mobileAgentModelItemSchema>
export type MobileAgentListParams = z.infer<typeof mobileAgentListParams>
export type MobileAgentListResult = z.infer<typeof mobileAgentListResult>
export type MobileAgentDetectParams = z.infer<typeof mobileAgentDetectParams>
export type MobileAgentDetectResult = z.infer<typeof mobileAgentDetectResult>
export type MobileAgentModelsParams = z.infer<typeof mobileAgentModelsParams>
export type MobileAgentModelsResult = z.infer<typeof mobileAgentModelsResult>
export type MobileAgentSetDefaultParams = z.infer<typeof mobileAgentSetDefaultParams>
export type MobileAgentSetDefaultResult = z.infer<typeof mobileAgentSetDefaultResult>
export type MobileAgentCreateInstanceParams = z.infer<typeof mobileAgentCreateInstanceParams>
export type MobileAgentCreateInstanceResult = z.infer<typeof mobileAgentCreateInstanceResult>
export type MobileAgentUpdateInstanceParams = z.infer<typeof mobileAgentUpdateInstanceParams>
export type MobileAgentUpdateInstanceResult = z.infer<typeof mobileAgentUpdateInstanceResult>
export type MobileAgentRemoveInstanceParams = z.infer<typeof mobileAgentRemoveInstanceParams>
export type MobileAgentRemoveInstanceResult = z.infer<typeof mobileAgentRemoveInstanceResult>
