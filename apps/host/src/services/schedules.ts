/**
 * 管理定时任务：持久化到 SQLite，Host 运行期间用 setTimeout 链触发。规则见 contracts 的 ScheduleRule
 * 与 nextScheduleRun；每次触发记一条运行历史（schedule_runs），结果从 runs 表读。
 */
import type { Context } from "cordis"
import {
  nextScheduleRunBefore,
  scheduleRuleSchema,
  type Schedule,
  type ScheduleRule,
  type ScheduleRun,
  type ScheduleRunStatus,
} from "@pigcode/contracts"
import { randomUUID } from "node:crypto"
import type { PigcodeDatabase } from "../storage/database"

/** 创建定时任务的输入；enabled 省略时默认启用，endsAt 省略时永不结束。 */
export interface CreateScheduleInput {
  threadId: string
  title?: string
  prompt: string
  rule: ScheduleRule
  endsAt?: string | null
  enabled?: boolean
}

/** 更新定时任务的输入；只修改给出的字段。 */
export interface UpdateScheduleInput {
  title?: string
  prompt?: string
  rule?: ScheduleRule
  endsAt?: string | null
  enabled?: boolean
}

/** 立即运行的结果：启动了、会话正忙、Agent 不可用，或者启动时出错。 */
export interface RunNowResult {
  status: "started" | "busy" | "unavailable" | "failed"
  runId: string | null
}

/** 定时任务触发时所需的 agents 服务方法；测试可注入替身。 */
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

/** schedules 插件依赖的存储与 agents 服务。 */
export const inject = ["storage", "agents"]

/** 注册 schedules 服务；timer 的启停由 Host 入口显式控制。 */
export function apply(ctx: Context): void {
  const schedules = new SchedulesService(ctx.storage.db, () => ctx.agents)
  ctx.provide("schedules", schedules)
  ctx.effect(() => () => schedules.stop())
}
apply.inject = inject

/** setTimeout 能等的最长时间（32 位有符号整数毫秒，约 24.8 天）；更远的下一次分几段等。 */
const MAX_TIMER_MS = 2 ** 31 - 1

/** SQLite 中的任务行。 */
interface ScheduleRow {
  id: string
  thread_id: string
  title: string
  prompt: string
  rule_json: string
  ends_at: string | null
  enabled: number
  next_run_at: string | null
  last_run_at: string | null
  last_run_id: string | null
  run_count: number
  created_at: string
  updated_at: string
}

/** 运行历史一行，连同它启动的 run 的状态。 */
interface ScheduleRunRow {
  id: string
  schedule_id: string
  source: "schedule" | "manual"
  status: "started" | "skipped" | "failed"
  run_id: string | null
  error: string | null
  triggered_at: string
  thread_id: string
  run_status: string | null
  completed_at: string | null
  error_message: string | null
}

/** 把数据库行映射为领域对象；没有下一次的任务已经过了结束日期。 */
function mapSchedule(row: ScheduleRow): Schedule {
  const enabled = row.enabled === 1
  return {
    id: row.id,
    threadId: row.thread_id,
    title: row.title,
    prompt: row.prompt,
    rule: scheduleRuleSchema.parse(JSON.parse(row.rule_json)),
    endsAt: row.ends_at,
    enabled,
    status: row.next_run_at === null ? "completed" : enabled ? "active" : "paused",
    nextRunAt: row.next_run_at,
    lastRunAt: row.last_run_at,
    lastRunId: row.last_run_id,
    runCount: row.run_count,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

/** 运行历史的一行：跳过与启动失败直接给出，启动了的看 run 自己的状态。 */
function mapRun(row: ScheduleRunRow): ScheduleRun {
  let status: ScheduleRunStatus
  if (row.status === "skipped") status = "skipped"
  else if (row.status === "failed") status = "failed"
  else if (row.run_status === "completed") status = "succeeded"
  else if (row.run_status === "failed") status = "failed"
  else if (row.run_status === "interrupted") status = "stopped"
  else status = "running"
  return {
    id: row.id,
    scheduleId: row.schedule_id,
    source: row.source,
    status,
    threadId: row.thread_id,
    runId: row.run_id,
    error: row.error ?? (status === "failed" ? row.error_message : null),
    triggeredAt: row.triggered_at,
    finishedAt: row.status === "started" ? row.completed_at : row.triggered_at,
  }
}

/** 校验规则并整理成存储的样子：星期几与几号去重排序。 */
function normalizeRule(rule: ScheduleRule): ScheduleRule {
  const parsed = scheduleRuleSchema.parse(rule)
  const sorted = (values: readonly number[]) =>
    [...new Set(values)].sort((left, right) => left - right)
  if (parsed.kind === "weekly" || parsed.kind === "everyWeeks" || parsed.kind === "everyMonths") {
    return { ...parsed, days: sorted(parsed.days) }
  }
  return parsed
}

/** 规则在 now 之后、结束日期之前的下一次运行时间；没有了时为 null。 */
function nextRunAt(rule: ScheduleRule, now: number, endsAt: string | null): string | null {
  return nextScheduleRunBefore(rule, new Date(now), endsAt)?.toISOString() ?? null
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

  /** 全部任务，新建的在前。 */
  list(): Schedule[] {
    const rows = this.db
      .prepare(`SELECT * FROM schedules ORDER BY created_at DESC, rowid DESC`)
      .all() as ScheduleRow[]
    return rows.map(mapSchedule)
  }

  create(input: CreateScheduleInput): Schedule {
    const rule = normalizeRule(input.rule)
    const endsAt = input.endsAt ?? null
    const now = Date.now()
    const at = new Date(now).toISOString()
    const id = `sch_${randomUUID()}`
    this.db
      .prepare(
        `INSERT INTO schedules (id, thread_id, title, prompt, rule_json, ends_at, enabled,
          next_run_at, last_run_at, last_run_id, run_count, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, 0, ?, ?)`,
      )
      .run(
        id,
        input.threadId,
        (input.title ?? "").trim(),
        input.prompt,
        JSON.stringify(rule),
        endsAt,
        (input.enabled ?? true) ? 1 : 0,
        nextRunAt(rule, now, endsAt),
        at,
        at,
      )
    const schedule = this.require(id)
    this.arm(schedule)
    return schedule
  }

  update(id: string, patch: UpdateScheduleInput): Schedule {
    const existing = this.require(id)
    const rule = patch.rule ? normalizeRule(patch.rule) : existing.rule
    const endsAt = patch.endsAt === undefined ? existing.endsAt : patch.endsAt
    const enabled = patch.enabled ?? existing.enabled
    // 改了规则或结束日期、或者重新启用时，从现在重新排下一次；只停用或改内容时保留原来的时间。
    const reschedule =
      JSON.stringify(rule) !== JSON.stringify(existing.rule) ||
      endsAt !== existing.endsAt ||
      (patch.enabled === true && !existing.enabled)
    this.db
      .prepare(
        `UPDATE schedules SET title = ?, prompt = ?, rule_json = ?, ends_at = ?, enabled = ?,
          next_run_at = ?, updated_at = ? WHERE id = ?`,
      )
      .run(
        (patch.title ?? existing.title).trim(),
        patch.prompt ?? existing.prompt,
        JSON.stringify(rule),
        endsAt,
        enabled ? 1 : 0,
        reschedule ? nextRunAt(rule, Date.now(), endsAt) : existing.nextRunAt,
        new Date().toISOString(),
        id,
      )
    const updated = this.require(id)
    this.arm(updated)
    return updated
  }

  delete(id: string): boolean {
    this.clearTimer(id)
    const result = this.db.prepare(`DELETE FROM schedules WHERE id = ?`).run(id)
    return result.changes > 0
  }

  /** 立即运行一次；不改动原来排好的下一次，也不影响 timer。 */
  async runNow(id: string): Promise<RunNowResult> {
    return this.trigger(this.require(id), "manual")
  }

  /** 一个任务的运行历史，新的在前。 */
  runs(id: string, limit = 20, offset = 0): { runs: ScheduleRun[]; total: number } {
    const rows = this.db
      .prepare(
        `SELECT sr.id, sr.schedule_id, sr.source, sr.status, sr.run_id, sr.error, sr.triggered_at,
           s.thread_id, r.status AS run_status, r.completed_at, r.error_message
         FROM schedule_runs sr
         JOIN schedules s ON s.id = sr.schedule_id
         LEFT JOIN runs r ON r.id = sr.run_id
         WHERE sr.schedule_id = ?
         ORDER BY sr.triggered_at DESC, sr.rowid DESC
         LIMIT ? OFFSET ?`,
      )
      .all(id, limit, offset) as ScheduleRunRow[]
    const total = this.db
      .prepare(`SELECT COUNT(*) FROM schedule_runs WHERE schedule_id = ?`)
      .pluck()
      .get(id) as number
    return { runs: rows.map(mapRun), total }
  }

  deleteRun(id: string): boolean {
    return this.db.prepare(`DELETE FROM schedule_runs WHERE id = ?`).run(id).changes > 0
  }

  start(): void {
    if (this.started) return
    this.started = true
    for (const schedule of this.list()) this.arm(schedule)
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

  private require(id: string): Schedule {
    const schedule = this.get(id)
    if (!schedule) throw new Error(`schedule not found: ${id}`)
    return schedule
  }

  /** 线程已有运行中或排队中的 run 时视为忙。 */
  private isBusy(runner: ScheduleRunner, threadId: string): boolean {
    return runner.listRuns().some((run) => run.threadId === threadId)
  }

  /** 按 next_run_at 安排下一次触发；过期的立刻补跑，太远的先等一段再看。 */
  private arm(schedule: Schedule): void {
    this.clearTimer(schedule.id)
    if (!this.started || !schedule.enabled || schedule.nextRunAt === null) return
    const delay = Math.min(Math.max(0, Date.parse(schedule.nextRunAt) - Date.now()), MAX_TIMER_MS)
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

  /** timer 到点：重新读取任务；删除、停用或还没到时间（分段等待）时不触发。 */
  private async onTimer(id: string): Promise<void> {
    this.timers.delete(id)
    if (!this.started) return
    const schedule = this.get(id)
    if (!schedule?.enabled || schedule.nextRunAt === null) return
    if (Date.parse(schedule.nextRunAt) > Date.now()) {
      this.arm(schedule)
      return
    }
    await this.trigger(schedule, "schedule")
  }

  /**
   * 触发一次：会话正忙或 Agent 不可用时跳过，否则启动 run。每次都记一条运行历史；
   * 到点的触发还要从现在排下一次，立即运行不动原来的时间。
   */
  private async trigger(schedule: Schedule, source: "schedule" | "manual"): Promise<RunNowResult> {
    if (this.firing.has(schedule.id)) return { status: "busy", runId: null }
    const runner = this.getRunner()
    const skip = (status: "busy" | "unavailable"): RunNowResult => {
      const now = Date.now()
      this.record(
        schedule.id,
        source,
        "skipped",
        null,
        status === "busy" ? "THREAD_BUSY" : "AGENT_UNAVAILABLE",
        now,
      )
      if (source === "schedule") this.advance(schedule.id, now)
      return { status, runId: null }
    }
    if (!runner) return skip("unavailable")
    if (this.isBusy(runner, schedule.threadId)) return skip("busy")

    this.firing.add(schedule.id)
    // 触发时刻记在启动之前：很快结束的 run 完成时间不会早于触发时间，时长才算得出来。
    const now = Date.now()
    let runId: string | null = null
    let failure: string | null = null
    try {
      runId = (await runner.startRun(schedule.threadId, schedule.prompt)).runId
    } catch (error) {
      // 线程被删除、队列已满等错误不应中断后续触发。
      failure = error instanceof Error ? error.message : String(error)
    } finally {
      this.firing.delete(schedule.id)
    }

    if (runId) {
      this.record(schedule.id, source, "started", runId, null, now)
      this.db
        .prepare(
          `UPDATE schedules SET last_run_at = ?, last_run_id = ?, run_count = run_count + 1
           WHERE id = ?`,
        )
        .run(new Date(now).toISOString(), runId, schedule.id)
    } else {
      this.record(schedule.id, source, "failed", null, failure, now)
    }
    if (source === "schedule") this.advance(schedule.id, now)
    return runId ? { status: "started", runId } : { status: "failed", runId: null }
  }

  /** 记一条运行历史；任务已被删除时不记。 */
  private record(
    scheduleId: string,
    source: "schedule" | "manual",
    status: "started" | "skipped" | "failed",
    runId: string | null,
    error: string | null,
    at: number,
  ): void {
    if (!this.get(scheduleId)) return
    this.db
      .prepare(
        `INSERT INTO schedule_runs (id, schedule_id, source, status, run_id, error, triggered_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        `srun_${randomUUID()}`,
        scheduleId,
        source,
        status,
        runId,
        error,
        new Date(at).toISOString(),
      )
  }

  /**
   * 到点触发之后从 now 排下一次：错过的不会连着补跑；过了结束日期时没有下一次，任务完成。
   */
  private advance(id: string, now: number): void {
    const current = this.get(id)
    if (!current) return
    this.db
      .prepare(`UPDATE schedules SET next_run_at = ? WHERE id = ?`)
      .run(nextRunAt(current.rule, now, current.endsAt), id)
    const updated = this.get(id)
    if (updated) this.arm(updated)
    else this.clearTimer(id)
  }
}
