/** 管理固定间隔的定时任务：持久化到 SQLite，Host 运行期间用 setTimeout 链触发。 */
import type { Context } from "cordis"
import type { Schedule } from "@pigcode/contracts"
import { randomUUID } from "node:crypto"
import type { PigcodeDatabase } from "../storage/database"

/** 创建定时任务的输入；enabled 省略时默认启用。 */
export interface CreateScheduleInput {
  threadId: string
  prompt: string
  intervalSeconds: number
  enabled?: boolean
}

/** 更新定时任务的输入；只修改给出的字段。 */
export interface UpdateScheduleInput {
  prompt?: string
  intervalSeconds?: number
  enabled?: boolean
}

/** 定时任务触发时所需的 provider 能力；测试可注入替身。 */
export interface ScheduleRunner {
  startRun(threadId: string, text: string): Promise<{ runId: string }>
  /** 返回运行中与排队中的 run，用于判断线程是否忙。 */
  listRuns(): Array<{ threadId: string }>
}

declare module "cordis" {
  interface Context {
    schedules: SchedulesService
  }
}

/** schedules 插件依赖的存储与 provider 服务。 */
export const inject = ["storage", "providers"]

/** 注册 schedules 服务；timer 的启停由 Host 入口显式控制。 */
export function apply(ctx: Context): void {
  const schedules = new SchedulesService(ctx.storage.db, () => ctx.providers)
  ctx.provide("schedules", schedules)
  ctx.effect(() => () => schedules.stop())
}
apply.inject = inject

/** SQLite 中的任务行。 */
interface ScheduleRow {
  id: string
  thread_id: string
  prompt: string
  interval_seconds: number
  enabled: number
  next_run_at: string
  last_run_at: string | null
  last_run_id: string | null
  created_at: string
}

/** 把数据库行映射为领域对象。 */
function mapSchedule(row: ScheduleRow): Schedule {
  return {
    id: row.id,
    threadId: row.thread_id,
    prompt: row.prompt,
    intervalSeconds: row.interval_seconds,
    enabled: row.enabled === 1,
    nextRunAt: row.next_run_at,
    lastRunAt: row.last_run_at,
    lastRunId: row.last_run_id,
    createdAt: row.created_at,
  }
}

/** 校验间隔必须是正整数秒。 */
function assertInterval(intervalSeconds: number): void {
  if (!Number.isInteger(intervalSeconds) || intervalSeconds <= 0) {
    throw new Error("intervalSeconds must be a positive integer")
  }
}

/** 定时任务实现；每次触发后排好下一次，避免 timer 重叠。 */
export class SchedulesService {
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>()
  /** 正在启动 run 的任务；防止同一任务并发触发。 */
  private readonly firing = new Set<string>()
  private started = false

  constructor(
    private readonly db: PigcodeDatabase,
    private readonly getRunner: () => ScheduleRunner | undefined,
  ) {}

  list(): Schedule[] {
    const rows = this.db
      .prepare(`SELECT * FROM schedules ORDER BY next_run_at ASC`)
      .all() as ScheduleRow[]
    return rows.map(mapSchedule)
  }

  create(input: CreateScheduleInput): Schedule {
    assertInterval(input.intervalSeconds)
    const now = Date.now()
    const schedule: Schedule = {
      id: `sch_${randomUUID()}`,
      threadId: input.threadId,
      prompt: input.prompt,
      intervalSeconds: input.intervalSeconds,
      enabled: input.enabled ?? true,
      nextRunAt: new Date(now + input.intervalSeconds * 1000).toISOString(),
      lastRunAt: null,
      lastRunId: null,
      createdAt: new Date(now).toISOString(),
    }
    this.db
      .prepare(
        `INSERT INTO schedules (id, thread_id, prompt, interval_seconds, enabled,
          next_run_at, last_run_at, last_run_id, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        schedule.id,
        schedule.threadId,
        schedule.prompt,
        schedule.intervalSeconds,
        schedule.enabled ? 1 : 0,
        schedule.nextRunAt,
        schedule.lastRunAt,
        schedule.lastRunId,
        schedule.createdAt,
      )
    this.arm(schedule)
    return schedule
  }

  update(id: string, patch: UpdateScheduleInput): Schedule {
    const existing = this.get(id)
    if (!existing) throw new Error(`schedule not found: ${id}`)
    const intervalSeconds = patch.intervalSeconds ?? existing.intervalSeconds
    assertInterval(intervalSeconds)
    const enabled = patch.enabled ?? existing.enabled
    // 改间隔或重新启用时，从当前时间重新起算；单纯停用时保留原 next。
    const resetTimer =
      patch.intervalSeconds !== undefined || (patch.enabled === true && !existing.enabled)
    const nextRunAt = resetTimer
      ? new Date(Date.now() + intervalSeconds * 1000).toISOString()
      : existing.nextRunAt
    const updated: Schedule = {
      ...existing,
      prompt: patch.prompt ?? existing.prompt,
      intervalSeconds,
      enabled,
      nextRunAt,
    }
    this.db
      .prepare(
        `UPDATE schedules SET prompt = ?, interval_seconds = ?, enabled = ?,
          next_run_at = ?, last_run_at = ?, last_run_id = ? WHERE id = ?`,
      )
      .run(
        updated.prompt,
        updated.intervalSeconds,
        updated.enabled ? 1 : 0,
        updated.nextRunAt,
        updated.lastRunAt,
        updated.lastRunId,
        updated.id,
      )
    if (updated.enabled) this.arm(updated)
    else this.clearTimer(updated.id)
    return updated
  }

  delete(id: string): boolean {
    this.clearTimer(id)
    const result = this.db.prepare(`DELETE FROM schedules WHERE id = ?`).run(id)
    return result.changes > 0
  }

  async runNow(id: string): Promise<{ runId: string | null }> {
    const schedule = this.get(id)
    if (!schedule) throw new Error(`schedule not found: ${id}`)
    this.clearTimer(id)
    const runner = this.getRunner()
    if (!runner || this.isBusy(runner, schedule.threadId)) {
      if (schedule.enabled) this.arm(schedule)
      return { runId: null }
    }
    const runId = await this.trigger(schedule)
    return { runId }
  }

  start(): void {
    if (this.started) return
    this.started = true
    for (const schedule of this.list()) {
      if (schedule.enabled) this.arm(schedule)
    }
  }

  stop(): void {
    this.started = false
    for (const timer of this.timers.values()) clearTimeout(timer)
    this.timers.clear()
  }

  /** 读取单条任务；不存在时返回 undefined。 */
  private get(id: string): Schedule | undefined {
    const row = this.db.prepare(`SELECT * FROM schedules WHERE id = ?`).get(id) as
      ScheduleRow | undefined
    return row ? mapSchedule(row) : undefined
  }

  /** 线程已有运行中或排队中的 run 时视为忙。 */
  private isBusy(runner: ScheduleRunner, threadId: string): boolean {
    return runner.listRuns().some((run) => run.threadId === threadId)
  }

  /** 按 next_run_at 安排下一次触发；0 延迟用于补跑过期任务。 */
  private arm(schedule: Schedule): void {
    this.clearTimer(schedule.id)
    if (!this.started || !schedule.enabled) return
    const delay = Math.max(0, Date.parse(schedule.nextRunAt) - Date.now())
    const timer = setTimeout(() => {
      void this.onTimer(schedule.id)
    }, delay)
    this.timers.set(schedule.id, timer)
  }

  private clearTimer(id: string): void {
    const timer = this.timers.get(id)
    if (timer === undefined) return
    clearTimeout(timer)
    this.timers.delete(id)
  }

  /** timer 到点：重新读取任务，删除或停用后不再触发。 */
  private async onTimer(id: string): Promise<void> {
    this.timers.delete(id)
    if (!this.started) return
    const schedule = this.get(id)
    if (!schedule?.enabled) return
    await this.trigger(schedule)
  }

  /** 启动一次 run 并推进时间戳；线程忙或启动失败时只推进 next_run_at。 */
  private async trigger(schedule: Schedule): Promise<string | null> {
    if (this.firing.has(schedule.id)) return null
    const runner = this.getRunner()
    const now = Date.now()
    if (!runner || this.isBusy(runner, schedule.threadId)) {
      this.writeTiming(schedule.id, now, null)
      this.rearm(schedule.id)
      return null
    }

    this.firing.add(schedule.id)
    let runId: string | null = null
    try {
      runId = (await runner.startRun(schedule.threadId, schedule.prompt)).runId
    } catch {
      // 线程被删除、队列已满等错误不应中断后续触发。
    } finally {
      this.firing.delete(schedule.id)
    }

    this.writeTiming(schedule.id, Date.now(), runId)
    this.rearm(schedule.id)
    return runId
  }

  /** 写入 last/next 时间；runId 为空表示本次没有真正启动。 */
  private writeTiming(id: string, now: number, runId: string | null): void {
    const current = this.get(id)
    if (!current) return
    const nextRunAt = new Date(now + current.intervalSeconds * 1000).toISOString()
    const lastRunAt = runId ? new Date(now).toISOString() : current.lastRunAt
    const lastRunId = runId ?? current.lastRunId
    this.db
      .prepare(
        `UPDATE schedules SET next_run_at = ?, last_run_at = ?, last_run_id = ?
         WHERE id = ?`,
      )
      .run(nextRunAt, lastRunAt, lastRunId, id)
  }

  /** 触发结束后按最新状态重新排期。 */
  private rearm(id: string): void {
    const updated = this.get(id)
    if (updated?.enabled) this.arm(updated)
    else this.clearTimer(id)
  }
}
