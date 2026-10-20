/** 定义 Pigcode 的持久领域实体与 provider 能力描述。 */
import { z } from "zod"

/** provider 支持的能力集合，Host 与插件据此协商可用功能。 */
export const providerCapabilitiesSchema = z.object({
  streaming: z.boolean(),
  approvals: z.boolean(),
  questions: z.boolean(),
  plan: z.boolean(),
  resume: z.boolean(),
  fork: z.boolean(),
  rollback: z.boolean(),
  checkpoint: z.boolean(),
  subagents: z.boolean(),
  mcp: z.boolean(),
  images: z.boolean(),
  usage: z.boolean(),
  modelCatalog: z.boolean(),
  nativeSessionId: z.boolean(),
})

/** 线程的执行权限模式。 */
export const permissionModeSchema = z.enum([
  "read-only",
  "workspace-write",
  "danger-full-access",
  "plan",
])

/** 项目实体，对应一个被 Pigcode 打开的本地根目录。 */
export const projectSchema = z.object({
  id: z.string().min(1),
  rootPath: z.string().min(1),
  name: z.string().min(1),
  createdAt: z.string().datetime(),
})

/** 线程实体，保存会话级 provider 与模型的最近选择。 */
export const threadSchema = z.object({
  id: z.string().min(1),
  projectId: z.string().min(1),
  title: z.string().min(1),
  defaultProviderId: z.string().min(1),
  lastProviderId: z.string().nullable(),
  lastModelId: z.string().nullable(),
  permissionMode: permissionModeSchema,
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
  archivedAt: z.string().datetime().nullable(),
  lastRunId: z.string().nullable(),
})

/** 一次运行的生命周期状态。 */
export const runStatusSchema = z.enum([
  "queued",
  "running",
  "waiting-approval",
  "waiting-input",
  "completed",
  "failed",
  "interrupted",
])

/** 运行实体，记录 provider 会话与终态信息。 */
export const runSchema = z.object({
  id: z.string().min(1),
  threadId: z.string().min(1),
  providerSessionId: z.string().min(1),
  status: runStatusSchema,
  startedAt: z.string().datetime(),
  completedAt: z.string().datetime().nullable(),
  errorCode: z.string().nullable(),
  errorMessage: z.string().nullable(),
  checkpointId: z.string().nullable(),
})

/** 执行条目的种类，用于渲染线程时间线。 */
export const executionItemKindSchema = z.enum([
  "message",
  "tool",
  "approval",
  "question",
  "plan",
  "file-change",
  "usage",
  "error",
])

/** 执行条目实体，payload 由具体类型决定。 */
export const executionItemSchema = z.object({
  id: z.string().min(1),
  threadId: z.string().min(1),
  runId: z.string().min(1),
  kind: executionItemKindSchema,
  parentId: z.string().nullable(),
  payload: z.unknown(),
  createdAt: z.string().datetime(),
})

/** 一个 provider 原生会话的持久记录。 */
export const providerSessionSchema = z.object({
  id: z.string().min(1),
  threadId: z.string().min(1),
  providerId: z.string().min(1),
  nativeSessionId: z.string().nullable(),
  cwd: z.string().min(1),
  status: z.enum(["active", "stopped", "orphaned"]),
  createdAt: z.string().datetime(),
  stoppedAt: z.string().datetime().nullable(),
})

/** 待审批/待回答请求的持久状态。 */
export const pendingRequestSchema = z.object({
  id: z.string().min(1),
  threadId: z.string().min(1),
  runId: z.string().min(1),
  kind: z.enum(["approval", "question"]),
  providerRequestId: z.string().nullable(),
  payload: z.unknown(),
  status: z.enum(["pending", "resolved", "orphaned"]),
  createdAt: z.string().datetime(),
  resolvedAt: z.string().datetime().nullable(),
})

/** provider 能力集合的类型。 */
export type ProviderCapabilities = z.infer<typeof providerCapabilitiesSchema>
/** 权限模式的类型。 */
export type PermissionMode = z.infer<typeof permissionModeSchema>
/** 项目的类型。 */
export type Project = z.infer<typeof projectSchema>
/** 线程的类型。 */
export type Thread = z.infer<typeof threadSchema>
/** 运行的类型。 */
export type Run = z.infer<typeof runSchema>
/** 运行状态的类型。 */
export type RunStatus = z.infer<typeof runStatusSchema>
/** 执行条目的类型。 */
export type ExecutionItem = z.infer<typeof executionItemSchema>
/** provider 原生会话记录的类型。 */
export type ProviderSession = z.infer<typeof providerSessionSchema>
/** 待审批/待回答请求的类型。 */
export type PendingRequest = z.infer<typeof pendingRequestSchema>
