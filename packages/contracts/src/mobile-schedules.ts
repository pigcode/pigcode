/** 手机端定时任务管理协议：剥离桌面端编辑器草稿，保留完整规则、执行配置、立即运行与历史分页。 */
import { z } from "zod"
import {
  scheduleExecutionSchema,
  scheduleRuleSchema,
  scheduleRunSchema,
  scheduleStatusSchema,
  scheduleTargetSchema,
} from "./domain"

export const MOBILE_SCHEDULE_TITLE_MAX_LENGTH = 120
export const MOBILE_SCHEDULE_PROMPT_MAX_LENGTH = 20_000
export const MOBILE_SCHEDULE_RUNS_DEFAULT_LIMIT = 20
export const MOBILE_SCHEDULE_RUNS_MAX_LIMIT = 50

export const mobileScheduleMethods = {
  list: "mobile.schedule.list",
  create: "mobile.schedule.create",
  update: "mobile.schedule.update",
  delete: "mobile.schedule.delete",
  runNow: "mobile.schedule.runNow",
  runs: "mobile.schedule.runs",
  deleteRun: "mobile.schedule.deleteRun",
} as const

const idSchema = z.string().min(1)
const titleSchema = z.string().trim().max(MOBILE_SCHEDULE_TITLE_MAX_LENGTH)
const promptInputSchema = z.string().trim().min(1).max(MOBILE_SCHEDULE_PROMPT_MAX_LENGTH)
const endsAtSchema = z.string().datetime().nullable()

/** 手机端定时任务摘要：刻意剥离桌面端 TipTap 富文本 draft。 */
export const mobileScheduleSchema = z
  .object({
    id: idSchema,
    target: scheduleTargetSchema,
    projectName: z.string().nullable(),
    threadTitle: z.string().nullable(),
    title: z.string().max(MOBILE_SCHEDULE_TITLE_MAX_LENGTH),
    prompt: z.string().min(1),
    rule: scheduleRuleSchema,
    endsAt: endsAtSchema,
    enabled: z.boolean(),
    status: scheduleStatusSchema,
    nextRunAt: z.string().datetime().nullable(),
    lastRunAt: z.string().datetime().nullable(),
    lastRunId: z.string().nullable(),
    runCount: z.number().int().nonnegative(),
    createdAt: z.string().datetime(),
    updatedAt: z.string().datetime(),
  })
  .strict()

export const mobileScheduleListParamsSchema = z.object({}).strict()
export const mobileScheduleListResultSchema = z
  .object({
    schedules: z.array(mobileScheduleSchema),
    truncated: z.boolean(),
  })
  .strict()

export const mobileScheduleCreateParamsSchema = z
  .object({
    projectId: idSchema,
    title: titleSchema.optional(),
    prompt: promptInputSchema,
    rule: scheduleRuleSchema,
    endsAt: endsAtSchema.optional(),
    enabled: z.boolean().optional(),
    execution: scheduleExecutionSchema.optional(),
  })
  .strict()

export const mobileScheduleUpdateParamsSchema = z
  .object({
    id: idSchema,
    title: titleSchema.optional(),
    prompt: promptInputSchema.optional(),
    rule: scheduleRuleSchema.optional(),
    endsAt: endsAtSchema.optional(),
    enabled: z.boolean().optional(),
    execution: scheduleExecutionSchema.optional(),
  })
  .strict()

export const mobileScheduleIdParamsSchema = z
  .object({
    id: idSchema,
  })
  .strict()

export const mobileScheduleDeleteResultSchema = z
  .object({
    deleted: z.boolean(),
  })
  .strict()

export const mobileScheduleRunNowStatusSchema = z.enum(["started", "busy", "unavailable", "failed"])

export const mobileScheduleRunNowResultSchema = z
  .object({
    status: mobileScheduleRunNowStatusSchema,
    runId: z.string().nullable(),
  })
  .strict()

export const mobileScheduleRunsParamsSchema = z
  .object({
    id: idSchema,
    limit: z
      .number()
      .int()
      .min(1)
      .max(MOBILE_SCHEDULE_RUNS_MAX_LIMIT)
      .default(MOBILE_SCHEDULE_RUNS_DEFAULT_LIMIT),
    offset: z.number().int().min(0).default(0),
  })
  .strict()

export const mobileScheduleRunsResultSchema = z
  .object({
    runs: z.array(scheduleRunSchema),
    total: z.number().int().nonnegative(),
  })
  .strict()

export const mobileScheduleDeleteRunParamsSchema = z
  .object({
    id: idSchema,
  })
  .strict()

export const mobileScheduleDeleteRunResultSchema = z
  .object({
    deleted: z.boolean(),
  })
  .strict()

export type MobileScheduleMethod =
  (typeof mobileScheduleMethods)[keyof typeof mobileScheduleMethods]
export type MobileSchedule = z.infer<typeof mobileScheduleSchema>
export type MobileScheduleListParams = z.infer<typeof mobileScheduleListParamsSchema>
export type MobileScheduleListResult = z.infer<typeof mobileScheduleListResultSchema>
export type MobileScheduleCreateParams = z.infer<typeof mobileScheduleCreateParamsSchema>
export type MobileScheduleUpdateParams = z.infer<typeof mobileScheduleUpdateParamsSchema>
export type MobileScheduleIdParams = z.infer<typeof mobileScheduleIdParamsSchema>
export type MobileScheduleDeleteResult = z.infer<typeof mobileScheduleDeleteResultSchema>
export type MobileScheduleRunNowStatus = z.infer<typeof mobileScheduleRunNowStatusSchema>
export type MobileScheduleRunNowResult = z.infer<typeof mobileScheduleRunNowResultSchema>
export type MobileScheduleRunsParams = z.infer<typeof mobileScheduleRunsParamsSchema>
export type MobileScheduleRunsResult = z.infer<typeof mobileScheduleRunsResultSchema>
export type MobileScheduleDeleteRunParams = z.infer<typeof mobileScheduleDeleteRunParamsSchema>
export type MobileScheduleDeleteRunResult = z.infer<typeof mobileScheduleDeleteRunResultSchema>
