/** 定义 Pigcode 的持久领域实体与 Agent 功能描述。 */
import { z } from "zod"

/**
 * Agent 功能：一个 Agent 支持哪些功能。
 *
 * **只是界面提示**：界面据它隐藏做不到的控件，Host 不拿它拒绝任何 RPC。
 * 真正的能力由 driver 自己决定——可选的 `askQuestions`、原生会话 id 的有无，
 * 都比一个布尔值可靠；再加一层校验就是第二个真相来源，不一致时更难查。
 * 所以这里的值必须和 driver 的实际实现对得上（Codex 的 fork 就曾经写着 false 而实现是真的）。
 */
export const agentFeaturesSchema = z.object({
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

/**
 * 推理强度（思考深度）。不同 agent 支持的档位不同：Codex 用 minimal–xhigh，
 * Claude 用 low–max；模型目录里的 efforts 列出该模型实际可选的档位。
 */
export const reasoningEffortSchema = z.enum(["minimal", "low", "medium", "high", "xhigh", "max"])

/** Agent 模型目录中的一项；efforts 为空表示该模型没有可调的思考深度。 */
export const agentModelSchema = z.object({
  id: z.string().min(1),
  displayName: z.string().min(1),
  description: z.string().optional(),
  isDefault: z.boolean(),
  efforts: z.array(reasoningEffortSchema),
  defaultEffort: reasoningEffortSchema.nullable(),
  /** 用户在 agent 设置里添加的模型 id，不在 agent 自己的目录里。 */
  custom: z.boolean().optional(),
})

/** 项目实体，对应一个被 Pigcode 打开的本地根目录。 */
export const projectSchema = z.object({
  id: z.string().min(1),
  rootPath: z.string().min(1),
  name: z.string().min(1),
  createdAt: z.string().datetime(),
})

/** 线程实体，保存会话级 Agent 与模型的最近选择。 */
export const threadSchema = z.object({
  id: z.string().min(1),
  projectId: z.string().min(1),
  title: z.string().min(1),
  defaultAgentId: z.string().min(1),
  lastAgentId: z.string().nullable(),
  lastModelId: z.string().nullable(),
  permissionMode: permissionModeSchema,
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
  archivedAt: z.string().datetime().nullable(),
  lastRunId: z.string().nullable(),
  /** 子代理会话所属的主会话；主会话为 null。子代理共用主会话的项目与工作目录，不出现在侧栏。 */
  parentThreadId: z.string().nullable().optional(),
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

/** 运行实体，记录 Agent 会话与终态信息。 */
export const runSchema = z.object({
  id: z.string().min(1),
  threadId: z.string().min(1),
  agentSessionId: z.string().min(1),
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

/** 一个 Agent 原生会话的持久记录。 */
export const agentSessionSchema = z.object({
  id: z.string().min(1),
  threadId: z.string().min(1),
  agentId: z.string().min(1),
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
  /** Agent 自己的请求 id。 */
  agentRequestId: z.string().nullable(),
  payload: z.unknown(),
  status: z.enum(["pending", "resolved", "orphaned"]),
  createdAt: z.string().datetime(),
  resolvedAt: z.string().datetime().nullable(),
})

/** GitHub PR 状态；gh CLI 只返回这三种大写状态。 */
export const pullRequestStateSchema = z.enum(["OPEN", "CLOSED", "MERGED"])

/** GitHub PR 摘要，供工作台 PR 面板展示。 */
export const pullRequestInfoSchema = z.object({
  number: z.number().int().positive(),
  url: z.string().min(1),
  state: pullRequestStateSchema,
  title: z.string(),
  headRefName: z.string().min(1),
  baseRefName: z.string().min(1),
})

/** 自定义重复「每 N 个单位」里 N 的上限。 */
export const MAX_SCHEDULE_EVERY = 200

/** 一天里的时刻「HH:MM」，24 小时制，按 Host 所在机器的本地时间。 */
export const clockTimeSchema = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/)

const minuteSchema = z.number().int().min(0).max(59)
/** 星期几，0–6 表示周日到周六，与 Date.getDay() 一致。 */
const weekdaySchema = z.number().int().min(0).max(6)
const weekdaysSchema = z.array(weekdaySchema).min(1).max(7)
/** 几号，1–31；那个月没有这一天时落在月末。 */
const monthDaySchema = z.number().int().min(1).max(31)
const everySchema = z.number().int().min(1).max(MAX_SCHEDULE_EVERY)
/** 自定义重复从哪一刻起算：每 N 天、每 N 周这类规则按它对齐周期。 */
const anchorSchema = z.string().datetime()

/**
 * 定时任务什么时候运行，都按 Host 所在机器的本地时间：
 * - 常用：每小时第几分、每天、每个工作日（周一到周五）、每周的某几天、每月几号；
 * - 自定义重复：每 N 分钟 / 小时 / 天 / 周 / 个月 / 年，按 anchor 对齐周期。每 N 个月可以按日期
 *   （每月的这几号），也可以按星期（每月的第一个周几）；每 N 年是某月某日。
 */
export const scheduleRuleSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("hourly"), minute: minuteSchema }),
  z.object({ kind: z.literal("daily"), time: clockTimeSchema }),
  z.object({ kind: z.literal("weekdays"), time: clockTimeSchema }),
  z.object({ kind: z.literal("weekly"), days: weekdaysSchema, time: clockTimeSchema }),
  z.object({ kind: z.literal("monthly"), day: monthDaySchema, time: clockTimeSchema }),
  z.object({ kind: z.literal("everyMinutes"), every: everySchema, anchor: anchorSchema }),
  z.object({
    kind: z.literal("everyHours"),
    every: everySchema,
    minute: minuteSchema,
    anchor: anchorSchema,
  }),
  z.object({
    kind: z.literal("everyDays"),
    every: everySchema,
    time: clockTimeSchema,
    anchor: anchorSchema,
  }),
  z.object({
    kind: z.literal("everyWeeks"),
    every: everySchema,
    days: weekdaysSchema,
    time: clockTimeSchema,
    anchor: anchorSchema,
  }),
  z.object({
    kind: z.literal("everyMonths"),
    every: everySchema,
    days: z.array(monthDaySchema).min(1).max(31),
    time: clockTimeSchema,
    anchor: anchorSchema,
  }),
  z.object({
    kind: z.literal("everyMonthsWeekday"),
    every: everySchema,
    weekday: weekdaySchema,
    time: clockTimeSchema,
    anchor: anchorSchema,
  }),
  z.object({
    kind: z.literal("everyYears"),
    every: everySchema,
    month: z.number().int().min(1).max(12),
    day: monthDaySchema,
    time: clockTimeSchema,
    anchor: anchorSchema,
  }),
])

/** 定时任务的状态：运行中、已暂停，或者过了结束日期、不会再运行的已完成。 */
export const scheduleStatusSchema = z.enum(["active", "paused", "completed"])

/** 定时任务；nextRunAt 在 Host 重启后继续生效，为 null 时任务已完成。 */
export const scheduleSchema = z.object({
  id: z.string().min(1),
  threadId: z.string().min(1),
  /** 可以留空，界面显示「未命名定时任务」。 */
  title: z.string().max(120),
  prompt: z.string().min(1),
  rule: scheduleRuleSchema,
  /** 结束日期：这一刻之后不再运行；null 表示永不结束。 */
  endsAt: z.string().datetime().nullable(),
  enabled: z.boolean(),
  status: scheduleStatusSchema,
  nextRunAt: z.string().datetime().nullable(),
  lastRunAt: z.string().datetime().nullable(),
  lastRunId: z.string().nullable(),
  /** 真正启动了 run 的次数；跳过的不算。 */
  runCount: z.number().int().nonnegative(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
})

/** 一次触发的结果：进行中、成功、失败、被停止，或者因为会话正忙、Agent 不可用而跳过。 */
export const scheduleRunStatusSchema = z.enum([
  "running",
  "succeeded",
  "failed",
  "stopped",
  "skipped",
])

/** 定时任务的一次触发：到点（schedule）或立即运行（manual）。 */
export const scheduleRunSchema = z.object({
  id: z.string().min(1),
  scheduleId: z.string().min(1),
  source: z.enum(["schedule", "manual"]),
  status: scheduleRunStatusSchema,
  threadId: z.string().min(1),
  /** 启动了的 run；跳过或启动失败时为 null。 */
  runId: z.string().nullable(),
  /** 跳过或失败的原因：THREAD_BUSY、AGENT_UNAVAILABLE，或者启动时的错误信息。 */
  error: z.string().nullable(),
  triggeredAt: z.string().datetime(),
  finishedAt: z.string().datetime().nullable(),
})

/** Agent 功能的类型。 */
export type AgentFeatures = z.infer<typeof agentFeaturesSchema>
/** 权限模式的类型。 */
export type PermissionMode = z.infer<typeof permissionModeSchema>
/** 推理强度的类型。 */
export type ReasoningEffort = z.infer<typeof reasoningEffortSchema>
/** 模型目录条目的类型。 */
export type AgentModel = z.infer<typeof agentModelSchema>
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
/** Agent 原生会话记录的类型。 */
export type AgentSession = z.infer<typeof agentSessionSchema>
/** 待审批/待回答请求的类型。 */
export type PendingRequest = z.infer<typeof pendingRequestSchema>
/** GitHub PR 状态的类型。 */
export type PullRequestState = z.infer<typeof pullRequestStateSchema>
/** GitHub PR 摘要的类型。 */
export type PullRequestInfo = z.infer<typeof pullRequestInfoSchema>
/** 定时任务的类型。 */
export type Schedule = z.infer<typeof scheduleSchema>
/** 定时任务运行规则的类型。 */
export type ScheduleRule = z.infer<typeof scheduleRuleSchema>
/** 定时任务状态的类型。 */
export type ScheduleStatus = z.infer<typeof scheduleStatusSchema>
/** 定时任务一次触发的类型。 */
export type ScheduleRun = z.infer<typeof scheduleRunSchema>
/** 定时任务一次触发结果的类型。 */
export type ScheduleRunStatus = z.infer<typeof scheduleRunStatusSchema>
