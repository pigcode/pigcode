/**
 * 管理定时任务：持久化到 SQLite，Host 运行期间用 setTimeout 链触发。规则见 contracts 的 ScheduleRule
 * 与 nextScheduleRun；每次触发记一条运行历史（schedule_runs），结果从 runs 表读。
 */
import type { Context } from "cordis"
import {
  DEFAULT_RUNTIME_MODE,
  nextScheduleRunBefore,
  scheduleExecutionSchema,
  scheduleRuleSchema,
  type ProjectScheduleTarget,
  type ReasoningEffort,
  type Schedule,
  type ScheduleExecution,
  type ScheduleRule,
  type ScheduleRun,
  type ScheduleRunChange,
  type ScheduleRunStatus,
  type Thread,
} from "@pigcode/contracts"
import { randomUUID } from "node:crypto"
import type { PigcodeDatabase } from "../storage/database"
import { createScheduledThread } from "./schedule-thread"

/** 创建定时任务的输入；enabled 省略时默认启用，endsAt 省略时永不结束。 */
export interface CreateScheduleInput {
  projectId: string
  execution?: ScheduleExecution
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
  execution?: ScheduleExecution
}

/** 立即运行的结果：启动了、上一轮尚未结束、Agent 不可用，或者启动时出错。 */
export interface RunNowResult {
  status: "started" | "busy" | "unavailable" | "failed"
  runId: string | null
}

/** 定时任务触发时所需的 agents 服务方法；测试可注入替身。 */
export interface ScheduleRunner {
  createThread(target: ProjectScheduleTarget, title: string): Promise<Thread>
  startRun(
    threadId: string,
    text: string,
    effort?: ReasoningEffort,
  ): Promise<{ runId: string; done?: Promise<void> }>
  /** 运行中与排队中的 run，用于防止同一个任务重叠运行。 */
  listRuns(): Array<{ runId: string; threadId: string }>
}

declare module "cordis" {
  interface Context {
    schedules: SchedulesService
  }
}

/** schedules 插件依赖的存储与 agents 服务。 */
export const inject = ["storage", "agents", "projects", "threads", "sessions"]

/** 注册 schedules 服务；timer 的启停由 Host 入口显式控制。 */
export function apply(ctx: Context): void {
  const schedules = new SchedulesService(ctx.storage.db, () => ({
    createThread: (target, title) => createScheduledThread(ctx, target, title),
    listRuns: () => ctx.agents.listRuns(),
    startRun: (threadId, text, effort) =>
      ctx.agents.startRun(threadId, text, undefined, effort ? { effort } : {}),
  }))
  ctx.provide("schedules", schedules)
  ctx.effect(() => () => schedules.stop())
}
apply.inject = inject

/** setTimeout 能等的最长时间（32 位有符号整数毫秒，约 24.8 天）；更远的下一次分几段等。 */
const MAX_TIMER_MS = 2 ** 31 - 1

/** SQLite 中的任务行。 */
interface ScheduleRow {
  id: string
  thread_id: string | null
  project_id: string | null
  execution_json: string | null
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
  thread_id: string | null
  run_status: string | null
  completed_at: string | null
  error_message: string | null
}

/** 把数据库行映射为领域对象；没有下一次的任务已经过了结束日期。 */
function mapSchedule(row: ScheduleRow): Schedule {
  const enabled = row.enabled === 1
  return {
    id: row.id,
    target:
      row.thread_id !== null
        ? { kind: "thread", threadId: row.thread_id }
        : {
            kind: "project",
            projectId: row.project_id!,
            execution: scheduleExecutionSchema.parse(JSON.parse(row.execution_json!)),
          },
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
  private readonly listeners = new Set<(change: ScheduleRunChange) => void>()
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
    if (
      !this.db
        .prepare(`SELECT 1 FROM projects WHERE id = ? AND archived_at IS NULL`)
        .get(input.projectId)
    ) {
      throw new Error("PROJECT_UNAVAILABLE")
    }
    const rule = normalizeRule(input.rule)
    const execution = scheduleExecutionSchema.parse(
      input.execution ?? { permissionMode: DEFAULT_RUNTIME_MODE },
    )
    const endsAt = input.endsAt ?? null
    const now = Date.now()
    const at = new Date(now).toISOString()
    const id = `sch_${randomUUID()}`
    this.db
      .prepare(
        `INSERT INTO schedules (id, project_id, execution_json, title, prompt, rule_json, ends_at, enabled,
          next_run_at, last_run_at, last_run_id, run_count, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, 0, ?, ?)`,
      )
      .run(
        id,
        input.projectId,
        JSON.stringify(execution),
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
    if (existing.target.kind === "thread" && patch.execution) {
      throw new Error("A legacy schedule uses its thread's execution settings")
    }
    const execution = patch.execution
      ? scheduleExecutionSchema.parse(patch.execution)
      : existing.target.kind === "project"
        ? existing.target.execution
        : null
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
          next_run_at = ?, updated_at = ?, execution_json = ? WHERE id = ?`,
      )
      .run(
        (patch.title ?? existing.title).trim(),
        patch.prompt ?? existing.prompt,
        JSON.stringify(rule),
        endsAt,
        enabled ? 1 : 0,
        reschedule ? nextRunAt(rule, Date.now(), endsAt) : existing.nextRunAt,
        new Date().toISOString(),
        execution === null ? null : JSON.stringify(execution),
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

  subscribe(listener: (change: ScheduleRunChange) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  /** 一个任务的运行历史，新的在前。 */
  runs(id: string, limit = 20, offset = 0): { runs: ScheduleRun[]; total: number } {
    const rows = this.db
      .prepare(
        `SELECT sr.id, sr.schedule_id, sr.source, sr.status, sr.run_id, sr.error, sr.triggered_at,
           sr.thread_id, r.status AS run_status, r.completed_at, r.error_message
         FROM schedule_runs sr
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

  private isBusy(runner: ScheduleRunner, schedule: Schedule): boolean {
    const { target, lastRunId } = schedule
    return runner
      .listRuns()
      .some((run) =>
        target.kind === "thread" ? run.threadId === target.threadId : run.runId === lastRunId,
      )
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
   * 触发一次：新任务先建会话，旧任务沿用绑定的会话。每次都记一条运行历史；
   * 到点的触发还要从现在排下一次，立即运行不动原来的时间。
   */
  private async trigger(schedule: Schedule, source: "schedule" | "manual"): Promise<RunNowResult> {
    const { target, id } = schedule
    const now = Date.now()
    const runner = this.getRunner()
    const skip = (status: "busy" | "unavailable", reason: string): RunNowResult => {
      this.record(id, source, "skipped", null, null, reason, now)
      if (source === "schedule") this.advance(id, now)
      this.publish({ scheduleId: id })
      return { status, runId: null }
    }
    if (!runner) return skip("unavailable", "AGENT_UNAVAILABLE")
    if (this.firing.has(id) || this.isBusy(runner, schedule)) {
      return skip("busy", target.kind === "thread" ? "THREAD_BUSY" : "SCHEDULE_BUSY")
    }

    this.firing.add(id)
    let thread: Thread | undefined
    let threadId = target.kind === "thread" ? target.threadId : null
    let run: Awaited<ReturnType<ScheduleRunner["startRun"]>> | undefined
    try {
      if (target.kind === "project") {
        const title = schedule.title || (schedule.prompt.split(/\r?\n/, 1)[0] ?? "").slice(0, 120)
        thread = await runner.createThread(target, title || "Scheduled task")
        threadId = thread.id
      }
      if (threadId === null) throw new Error("THREAD_UNAVAILABLE")
      const effort = target.kind === "project" ? target.execution.effort : undefined
      run = await runner.startRun(threadId, schedule.prompt, effort)
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error)
      if (reason === "AGENT_UNAVAILABLE" && !thread) return skip("unavailable", reason)
      this.record(id, source, "failed", threadId, null, reason, now)
    } finally {
      this.firing.delete(id)
    }

    if (run) {
      this.record(id, source, "started", threadId, run.runId, null, now)
      this.db
        .prepare(
          `UPDATE schedules SET last_run_at = ?, last_run_id = ?, run_count = run_count + 1
           WHERE id = ?`,
        )
        .run(new Date(now).toISOString(), run.runId, id)
    }
    if (source === "schedule") this.advance(id, now)
    this.publish({ scheduleId: id, ...(thread ? { thread } : {}) })
    void run?.done?.then(() => this.publish({ scheduleId: id }))
    return run ? { status: "started", runId: run.runId } : { status: "failed", runId: null }
  }

  private publish(change: ScheduleRunChange): void {
    for (const listener of this.listeners) listener(change)
  }

  /** 记一条运行历史；任务已被删除时不记。 */
  private record(
    scheduleId: string,
    source: "schedule" | "manual",
    status: "started" | "skipped" | "failed",
    threadId: string | null,
    runId: string | null,
    error: string | null,
    at: number,
  ): void {
    if (!this.get(scheduleId)) return
    this.db
      .prepare(
        `INSERT INTO schedule_runs (id, schedule_id, thread_id, source, status, run_id, error, triggered_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        `srun_${randomUUID()}`,
        scheduleId,
        threadId,
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
