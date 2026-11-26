/**
 * 手机端定时任务管理处理器：
 * - 复用桌面端 SchedulesService 持久化与排期逻辑，剥离富文本 draft，补齐项目/会话展示名；
 * - 列表与运行历史严格控制在 48 KiB UTF-8 JSON 预算内，满足单帧 Noise 加密上限。
 */
import type { Context } from "cordis"
import {
  mobileScheduleCreateParamsSchema,
  mobileScheduleDeleteResultSchema,
  mobileScheduleDeleteRunParamsSchema,
  mobileScheduleDeleteRunResultSchema,
  mobileScheduleIdParamsSchema,
  mobileScheduleListParamsSchema,
  mobileScheduleListResultSchema,
  mobileScheduleMethods,
  mobileScheduleRunNowResultSchema,
  mobileScheduleRunsParamsSchema,
  mobileScheduleRunsResultSchema,
  mobileScheduleSchema,
  mobileScheduleUpdateParamsSchema,
  type MobileSchedule,
  type MobileScheduleCreateParams,
  type MobileScheduleRunsParams,
  type MobileScheduleUpdateParams,
  type RpcRequest,
  type Schedule,
  type ScheduleRun,
} from "@pigcode/contracts"
import type { SchedulesService } from "../services/schedules"
import { mobileParams as params, MobileRequestError } from "./request-error"

export const mobileScheduleRequests = new Set<string>(Object.values(mobileScheduleMethods))

const SCHEDULE_JSON_BUDGET_BYTES = 48 * 1024

function truncateUtf8(text: string, maxBytes: number): string {
  if (maxBytes <= 0) return ""
  if (Buffer.byteLength(text, "utf8") <= maxBytes) return text
  const ellipsis = "…"
  const limit = Math.max(0, maxBytes - Buffer.byteLength(ellipsis, "utf8"))
  let out = ""
  let used = 0
  for (const ch of text) {
    const chBytes = Buffer.byteLength(ch, "utf8")
    if (used + chBytes > limit) break
    out += ch
    used += chBytes
  }
  return out + ellipsis
}

function fitSchedulesWithinBudget(
  items: readonly MobileSchedule[],
  budgetBytes = SCHEDULE_JSON_BUDGET_BYTES,
): { schedules: MobileSchedule[]; truncated: boolean } {
  const accepted: MobileSchedule[] = []
  let used = Buffer.byteLength('{"schedules":[],"truncated":true}', "utf8")
  let truncated = false

  for (const item of items) {
    const itemBytes = Buffer.byteLength(JSON.stringify(item), "utf8") + 1
    if (used + itemBytes <= budgetBytes) {
      accepted.push(item)
      used += itemBytes
      continue
    }
    truncated = true
    if (accepted.length === 0) {
      // 单条桌面任务的 prompt 极大时，仅对其做预算裁剪以确保列表仍可展示且不超帧。
      const shellBytes = Buffer.byteLength(JSON.stringify({ ...item, prompt: "" }), "utf8") + 1
      const availableForPrompt = budgetBytes - used - shellBytes - 64
      if (availableForPrompt > 16) {
        const shrunk: MobileSchedule = {
          ...item,
          prompt: truncateUtf8(item.prompt, Math.floor(availableForPrompt / 2)),
        }
        const shrunkBytes = Buffer.byteLength(JSON.stringify(shrunk), "utf8") + 1
        if (used + shrunkBytes <= budgetBytes) {
          accepted.push(shrunk)
        }
      }
    }
    break
  }

  return { schedules: accepted, truncated }
}

function fitRunsWithinBudget(
  items: readonly ScheduleRun[],
  total: number,
  budgetBytes = SCHEDULE_JSON_BUDGET_BYTES,
): ScheduleRun[] {
  const accepted: ScheduleRun[] = []
  let used = Buffer.byteLength(JSON.stringify({ runs: [], total }), "utf8")

  for (const item of items) {
    const itemBytes = Buffer.byteLength(JSON.stringify(item), "utf8") + 1
    if (used + itemBytes <= budgetBytes) {
      accepted.push(item)
      used += itemBytes
      continue
    }
    if (accepted.length === 0 && item.error) {
      const shrunk: ScheduleRun = { ...item, error: truncateUtf8(item.error, 1024) }
      const shrunkBytes = Buffer.byteLength(JSON.stringify(shrunk), "utf8") + 1
      if (used + shrunkBytes <= budgetBytes) {
        accepted.push(shrunk)
      }
    }
    break
  }

  return accepted
}

function mapScheduleError(error: unknown): never {
  if (error instanceof MobileRequestError) throw error
  const message = error instanceof Error ? error.message : String(error)
  if (/schedule not found/i.test(message)) {
    throw new MobileRequestError("SCHEDULE_NOT_FOUND")
  }
  if (/legacy schedule/i.test(message)) {
    throw new MobileRequestError("SCHEDULE_LEGACY_LOCKED")
  }
  if (/PROJECT_UNAVAILABLE/i.test(message)) {
    throw new MobileRequestError("RESOURCE_NOT_AVAILABLE")
  }
  throw new MobileRequestError("COMMAND_FAILED")
}

export class MobileScheduleManage {
  constructor(
    private readonly ctx: Context,
    private readonly requirePairedDevice: () => void,
  ) {}

  async dispatch(request: RpcRequest): Promise<unknown> {
    this.requirePairedDevice()
    const schedules = this.ctx.get("schedules")
    if (!schedules) throw new MobileRequestError("METHOD_NOT_AVAILABLE")

    switch (request.method) {
      case mobileScheduleMethods.list:
        params(mobileScheduleListParamsSchema, request.params)
        return this.list(schedules)
      case mobileScheduleMethods.create:
        return this.create(schedules, params(mobileScheduleCreateParamsSchema, request.params))
      case mobileScheduleMethods.update:
        return this.update(schedules, params(mobileScheduleUpdateParamsSchema, request.params))
      case mobileScheduleMethods.delete:
        return this.remove(schedules, params(mobileScheduleIdParamsSchema, request.params).id)
      case mobileScheduleMethods.runNow:
        return this.runNow(schedules, params(mobileScheduleIdParamsSchema, request.params).id)
      case mobileScheduleMethods.runs:
        return this.runs(schedules, params(mobileScheduleRunsParamsSchema, request.params))
      case mobileScheduleMethods.deleteRun:
        return this.deleteRun(
          schedules,
          params(mobileScheduleDeleteRunParamsSchema, request.params).id,
        )
      default:
        throw new MobileRequestError("METHOD_NOT_AVAILABLE")
    }
  }

  private toMobileSchedule(schedule: Schedule): MobileSchedule {
    let projectName: string | null = null
    let threadTitle: string | null = null
    if (schedule.target.kind === "project") {
      projectName = this.ctx.projects.get(schedule.target.projectId)?.name ?? null
    } else {
      const thread = this.ctx.threads.get(schedule.target.threadId)
      threadTitle = thread?.title ?? null
      projectName = thread ? (this.ctx.projects.get(thread.projectId)?.name ?? null) : null
    }
    return {
      id: schedule.id,
      target: schedule.target,
      projectName,
      threadTitle,
      title: schedule.title,
      prompt: schedule.prompt,
      rule: schedule.rule,
      endsAt: schedule.endsAt,
      enabled: schedule.enabled,
      status: schedule.status,
      nextRunAt: schedule.nextRunAt,
      lastRunAt: schedule.lastRunAt,
      lastRunId: schedule.lastRunId,
      runCount: schedule.runCount,
      createdAt: schedule.createdAt,
      updatedAt: schedule.updatedAt,
    }
  }

  private list(schedules: SchedulesService) {
    const mapped = schedules.list().map((schedule) => this.toMobileSchedule(schedule))
    const clipped = fitSchedulesWithinBudget(mapped)
    return mobileScheduleListResultSchema.parse(clipped)
  }

  private create(schedules: SchedulesService, input: MobileScheduleCreateParams) {
    const activeProject = this.ctx.projects.list().some((project) => project.id === input.projectId)
    if (!activeProject) throw new MobileRequestError("RESOURCE_NOT_AVAILABLE")
    try {
      const created = schedules.create({
        projectId: input.projectId,
        prompt: input.prompt,
        rule: input.rule,
        ...(input.title !== undefined ? { title: input.title } : {}),
        ...(input.endsAt !== undefined ? { endsAt: input.endsAt } : {}),
        ...(input.enabled !== undefined ? { enabled: input.enabled } : {}),
        ...(input.execution !== undefined ? { execution: input.execution } : {}),
      })
      return mobileScheduleSchema.parse(this.toMobileSchedule(created))
    } catch (error) {
      mapScheduleError(error)
    }
  }

  private update(schedules: SchedulesService, input: MobileScheduleUpdateParams) {
    try {
      const updated = schedules.update(input.id, {
        ...(input.title !== undefined ? { title: input.title } : {}),
        ...(input.prompt !== undefined ? { prompt: input.prompt } : {}),
        ...(input.rule !== undefined ? { rule: input.rule } : {}),
        ...(input.endsAt !== undefined ? { endsAt: input.endsAt } : {}),
        ...(input.enabled !== undefined ? { enabled: input.enabled } : {}),
        ...(input.execution !== undefined ? { execution: input.execution } : {}),
      })
      return mobileScheduleSchema.parse(this.toMobileSchedule(updated))
    } catch (error) {
      mapScheduleError(error)
    }
  }

  private remove(schedules: SchedulesService, id: string) {
    return mobileScheduleDeleteResultSchema.parse({ deleted: schedules.delete(id) })
  }

  private async runNow(schedules: SchedulesService, id: string) {
    try {
      const result = await schedules.runNow(id)
      return mobileScheduleRunNowResultSchema.parse(result)
    } catch (error) {
      mapScheduleError(error)
    }
  }

  private runs(schedules: SchedulesService, input: MobileScheduleRunsParams) {
    const exists = schedules.list().some((schedule) => schedule.id === input.id)
    if (!exists) throw new MobileRequestError("SCHEDULE_NOT_FOUND")
    const page = schedules.runs(input.id, input.limit, input.offset)
    const runs = fitRunsWithinBudget(page.runs, page.total)
    return mobileScheduleRunsResultSchema.parse({ runs, total: page.total })
  }

  private deleteRun(schedules: SchedulesService, id: string) {
    return mobileScheduleDeleteRunResultSchema.parse({ deleted: schedules.deleteRun(id) })
  }
}
