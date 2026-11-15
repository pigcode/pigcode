/**
 * 验证定时任务服务：每次新建会话、忙时跳过、重启恢复与补跑、旧任务迁移与运行历史。
 * 日历规则按本地时间算：时间都用本地时间构造，测试在任何时区都成立；2026-11-06 是周五。
 */
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Context } from "cordis"
import type { ScheduleRule } from "@pigcode/contracts"
import Database from "better-sqlite3"
import { afterEach, describe, expect, it, vi } from "vitest"
import { apply as projects } from "./projects"
import { SchedulesService, type ScheduleRunner } from "./schedules"
import { apply as storage } from "./storage"
import { apply as threads } from "./threads"
import { migrate } from "../storage/migrations"

/** 建立没有会话的项目，使用测试替身启动 run。 */
async function setup(dbPath = ":memory:", withRunner = true) {
  const ctx = new Context()
  await ctx.plugin(storage, { path: dbPath })
  await ctx.plugin(projects)
  await ctx.plugin(threads)
  const project = ctx.projects.add("/tmp/pigcode-schedules")
  let counter = 0
  const createThread = vi.fn<ScheduleRunner["createThread"]>(async (target, title) =>
    ctx.threads.create(target.projectId, title, "fake", undefined, target.execution),
  )
  const startRun = vi.fn<ScheduleRunner["startRun"]>(async () => ({ runId: `run_${++counter}` }))
  const listRuns = vi.fn<ScheduleRunner["listRuns"]>(() => [])
  const runner: ScheduleRunner = { createThread, startRun, listRuns }
  const service = new SchedulesService(ctx.storage.db, () => (withRunner ? runner : undefined))
  return { ctx, project, service, runner, createThread, startRun, listRuns }
}

const local = (month: number, day: number, hours: number, minutes = 0) =>
  new Date(2026, month - 1, day, hours, minutes)
const iso = (month: number, day: number, hours: number, minutes = 0) =>
  local(month, day, hours, minutes).toISOString()
/** 每分钟一次，从 2026-10-20 00:00 UTC 起算。 */
const EVERY_MINUTE: ScheduleRule = {
  kind: "everyMinutes",
  every: 1,
  anchor: "2026-10-20T00:00:00.000Z",
}

const dirs: string[] = []

afterEach(async () => {
  vi.useRealTimers()
  await Promise.all(
    dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true, maxRetries: 5 })),
  )
})

describe("SchedulesService", () => {
  it("creates a different thread on each tick and records the thread in its history", async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date("2026-10-20T00:00:00.000Z"))
    const { ctx, project, service, startRun } = await setup()
    service.start()
    const schedule = service.create({
      projectId: project.id,
      title: "  Digest  ",
      prompt: "summarize",
      rule: EVERY_MINUTE,
      execution: {
        instanceId: "fake",
        modelId: "fake-pro",
        effort: "high",
        fast: true,
        ultracode: true,
        permissionMode: "approval-required",
      },
      draft: {
        document: '{"type":"doc"}',
        references: [{ kind: "thread", threadId: "th_reference" }],
      },
    })
    expect(schedule).toMatchObject({
      title: "Digest",
      status: "active",
      runCount: 0,
      endsAt: null,
      nextRunAt: "2026-10-20T00:01:00.000Z",
    })

    expect(ctx.threads.list(project.id)).toEqual([])
    await vi.advanceTimersByTimeAsync(60_000)

    const firstThread = ctx.threads.list(project.id)[0]!
    expect(firstThread).toMatchObject({
      title: "Digest",
      lastModelId: "fake-pro",
      permissionMode: "approval-required",
    })
    expect(startRun).toHaveBeenCalledExactlyOnceWith(firstThread.id, "summarize", {
      effort: "high",
      fast: true,
      ultracode: true,
      references: [{ kind: "thread", threadId: "th_reference" }],
    })
    expect(service.list()[0]).toMatchObject({
      lastRunAt: "2026-10-20T00:01:00.000Z",
      lastRunId: "run_1",
      runCount: 1,
      nextRunAt: "2026-10-20T00:02:00.000Z",
    })

    await vi.advanceTimersByTimeAsync(60_000)
    expect(startRun).toHaveBeenCalledTimes(2)
    const [secondThreadId] = startRun.mock.calls[1]!
    expect(secondThreadId).not.toBe(firstThread.id)
    expect(service.runs(schedule.id)).toMatchObject({
      total: 2,
      runs: [
        { source: "schedule", status: "running", runId: "run_2", threadId: secondThreadId },
        { source: "schedule", status: "running", runId: "run_1", threadId: firstThread.id },
      ],
    })

    service.stop()
    await ctx.fiber.dispose()
  })

  it("keeps a v7 task and its history bound to the original thread after upgrading", async () => {
    const db = new Database(":memory:")
    db.pragma("foreign_keys = ON")
    try {
      migrate(db, 7)
      const at = "2026-10-20T00:00:00.000Z"
      db.exec(`
        INSERT INTO projects (id, root_path, name, created_at) VALUES ('pr_old', '/old', 'Old', '${at}');
        INSERT INTO threads (id, project_id, title, default_agent_id, permission_mode, created_at, updated_at)
          VALUES ('th_old', 'pr_old', 'Old thread', 'fake', 'approval-required', '${at}', '${at}');
        INSERT INTO schedules (id, thread_id, title, prompt, rule_json, enabled, created_at, updated_at)
          VALUES ('sch_old', 'th_old', 'Old schedule', 'digest', '{"kind":"daily","time":"09:00"}', 0, '${at}', '${at}');
        INSERT INTO schedule_runs (id, schedule_id, source, status, run_id, triggered_at)
          VALUES ('srun_old', 'sch_old', 'manual', 'started', 'run_old', '${at}');
      `)
      migrate(db)

      const createThread = vi.fn<ScheduleRunner["createThread"]>()
      const startRun = vi.fn(async () => ({ runId: "run_next" }))
      const service = new SchedulesService(db, () => ({
        createThread,
        startRun,
        listRuns: () => [],
      }))
      expect(db.pragma("foreign_key_check")).toEqual([])
      expect(service.list()[0]?.target).toEqual({ kind: "thread", threadId: "th_old" })
      expect(await service.runNow("sch_old")).toEqual({ status: "started", runId: "run_next" })
      expect(startRun).toHaveBeenCalledWith("th_old", "digest", {})
      expect(createThread).not.toHaveBeenCalled()
      expect(service.runs("sch_old").runs).toMatchObject([
        { runId: "run_next", threadId: "th_old" },
        { runId: "run_old", threadId: "th_old" },
      ])
    } finally {
      db.close()
    }
  })

  it("rejects a malformed rule", async () => {
    const { ctx, project, service } = await setup()
    const create = (rule: ScheduleRule) =>
      service.create({ projectId: project.id, prompt: "x", rule })
    expect(() => create({ kind: "daily", time: "25:00" })).toThrow()
    expect(() => create({ kind: "weekly", days: [], time: "09:00" })).toThrow()
    expect(() => create({ kind: "hourly", minute: 60 })).toThrow()
    expect(() => create({ ...EVERY_MINUTE, every: 201 })).toThrow()
    expect(service.list()).toEqual([])
    await ctx.fiber.dispose()
  })

  it("skips a tick while the previous run is active and advances the schedule", async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date("2026-10-20T00:00:00.000Z"))
    const { ctx, project, service, startRun, listRuns } = await setup()
    service.start()
    const schedule = service.create({
      projectId: project.id,
      prompt: "summarize",
      rule: EVERY_MINUTE,
    })
    await service.runNow(schedule.id)
    listRuns.mockReturnValue([{ runId: "run_1", threadId: startRun.mock.calls[0]![0] }])

    await vi.advanceTimersByTimeAsync(60_000)

    expect(startRun).toHaveBeenCalledTimes(1)
    expect(service.list()[0]).toMatchObject({
      lastRunAt: "2026-10-20T00:00:00.000Z",
      lastRunId: "run_1",
      runCount: 1,
      nextRunAt: "2026-10-20T00:02:00.000Z",
    })
    expect(service.runs(schedule.id).runs[0]).toMatchObject({
      status: "skipped",
      error: "SCHEDULE_BUSY",
      runId: null,
      threadId: null,
    })

    service.stop()
    await ctx.fiber.dispose()
  })

  it("restores schedules and their next_run_at from the same database", async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date("2026-10-20T00:00:00.000Z"))
    const { ctx, project, service, runner, startRun } = await setup()
    service.start()
    service.create({ projectId: project.id, prompt: "summarize", rule: EVERY_MINUTE })
    service.stop()

    const restored = new SchedulesService(ctx.storage.db, () => runner)
    expect(restored.list()[0]?.nextRunAt).toBe("2026-10-20T00:01:00.000Z")
    restored.start()
    await vi.advanceTimersByTimeAsync(60_000)

    expect(startRun).toHaveBeenCalledTimes(1)
    restored.stop()
    await ctx.fiber.dispose()
  })

  // 上面一条只是换了一个服务实例，数据库和进程都还在。这里让旧 Host 真正关掉，
  // 新 Host 从同一个文件重新打开，模拟重启。
  it("fires on schedule across a real Host restart on the same file", async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date("2026-10-20T00:00:00.000Z"))
    const dir = await mkdtemp(join(tmpdir(), "pigcode-schedules-"))
    dirs.push(dir)
    const dbPath = join(dir, "pigcode.db")

    const before = await setup(dbPath)
    before.service.start()
    before.service.create({ projectId: before.project.id, prompt: "summarize", rule: EVERY_MINUTE })
    await vi.advanceTimersByTimeAsync(60_000)
    expect(before.startRun).toHaveBeenCalledTimes(1)
    before.service.stop()
    await before.ctx.fiber.dispose()

    const after = await setup(dbPath)
    after.service.start()
    // 重启时这个任务还没到期，不能补跑；再过一分钟才触发一次。
    await vi.advanceTimersByTimeAsync(59_000)
    expect(after.startRun).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1_000)
    expect(after.startRun).toHaveBeenCalledTimes(1)
    expect(after.service.list()[0]?.lastRunAt).toBe("2026-10-20T00:02:00.000Z")

    after.service.stop()
    await after.ctx.fiber.dispose()
  })

  it("catches up an overdue schedule exactly once after start", async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date("2026-10-20T00:00:00.000Z"))
    const { ctx, project, service, runner, startRun } = await setup()
    service.start()
    service.create({ projectId: project.id, prompt: "summarize", rule: EVERY_MINUTE })
    service.stop()

    vi.setSystemTime(new Date("2026-10-20T00:05:00.000Z"))
    const restored = new SchedulesService(ctx.storage.db, () => runner)
    restored.start()
    await vi.advanceTimersByTimeAsync(0)
    expect(startRun).toHaveBeenCalledTimes(1)
    expect(restored.list()[0]).toMatchObject({
      lastRunAt: "2026-10-20T00:05:00.000Z",
      nextRunAt: "2026-10-20T00:06:00.000Z",
    })

    restored.stop()
    await ctx.fiber.dispose()
  })

  it("does not fire after the schedule is deleted, and drops its history with it", async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date("2026-10-20T00:00:00.000Z"))
    const { ctx, project, service, startRun } = await setup()
    service.start()
    const schedule = service.create({
      projectId: project.id,
      prompt: "summarize",
      rule: EVERY_MINUTE,
    })
    await service.runNow(schedule.id)
    expect(service.runs(schedule.id).total).toBe(1)

    expect(service.delete(schedule.id)).toBe(true)
    expect(service.list()).toEqual([])
    expect(ctx.storage.db.prepare(`SELECT COUNT(*) FROM schedule_runs`).pluck().get()).toBe(0)
    await vi.advanceTimersByTimeAsync(120_000)
    expect(startRun).toHaveBeenCalledTimes(1)
    expect(service.delete(schedule.id)).toBe(false)

    service.stop()
    await ctx.fiber.dispose()
  })

  it("runs a weekday rule at its local time and skips the weekend", async () => {
    vi.useFakeTimers()
    vi.setSystemTime(local(11, 6, 8))
    const { ctx, project, service, startRun } = await setup()
    service.start()
    const schedule = service.create({
      projectId: project.id,
      prompt: "standup",
      rule: { kind: "weekdays", time: "09:00" },
    })
    expect(schedule.nextRunAt).toBe(iso(11, 6, 9))

    await vi.advanceTimersByTimeAsync(60 * 60_000)

    expect(startRun).toHaveBeenCalledTimes(1)
    expect(service.list()[0]?.nextRunAt).toBe(iso(11, 9, 9))
    service.stop()
    await ctx.fiber.dispose()
  })

  it("moves to the new rule's next time, and keeps the time when pausing or editing text", async () => {
    vi.useFakeTimers()
    vi.setSystemTime(local(11, 7, 10, 30))
    const { ctx, project, service } = await setup()
    const schedule = service.create({
      projectId: project.id,
      prompt: "digest",
      rule: { kind: "daily", time: "09:00" },
    })
    // 今天的 09:00 已经过了，第一次是明天。
    expect(schedule.nextRunAt).toBe(iso(11, 8, 9))

    const weekly = service.update(schedule.id, {
      rule: { kind: "weekly", days: [5, 3, 3], time: "16:00" },
    })
    expect(weekly.rule).toEqual({ kind: "weekly", days: [3, 5], time: "16:00" })
    expect(weekly.nextRunAt).toBe(iso(11, 11, 16))
    const paused = service.update(schedule.id, { enabled: false })
    expect(paused).toMatchObject({ status: "paused", nextRunAt: weekly.nextRunAt })
    const renamed = service.update(schedule.id, { title: "Weekly", prompt: "weekly digest" })
    expect(renamed).toMatchObject({ title: "Weekly", nextRunAt: weekly.nextRunAt })
    await ctx.fiber.dispose()
  })

  it("completes after its end date and no longer fires", async () => {
    vi.useFakeTimers()
    vi.setSystemTime(local(11, 6, 8))
    const { ctx, project, service, startRun } = await setup()
    service.start()
    const schedule = service.create({
      projectId: project.id,
      prompt: "standup",
      rule: { kind: "daily", time: "09:00" },
      endsAt: iso(11, 6, 23, 59),
    })
    expect(schedule).toMatchObject({ status: "active", nextRunAt: iso(11, 6, 9) })

    await vi.advanceTimersByTimeAsync(2 * 24 * 60 * 60_000)

    expect(startRun).toHaveBeenCalledTimes(1)
    expect(service.list()[0]).toMatchObject({ status: "completed", nextRunAt: null, runCount: 1 })
    // 延长结束日期后从现在（11-08 08:00）重新排上。
    const extended = service.update(schedule.id, { endsAt: null })
    expect(extended).toMatchObject({ status: "active", nextRunAt: iso(11, 8, 9) })
    service.stop()
    await ctx.fiber.dispose()
  })

  it("waits more than setTimeout can in one go for a monthly rule", async () => {
    vi.useFakeTimers()
    vi.setSystemTime(local(11, 2, 8))
    const { ctx, project, service, startRun } = await setup()
    service.start()
    service.create({
      projectId: project.id,
      prompt: "invoice",
      rule: { kind: "monthly", day: 1, time: "09:00" },
    })
    expect(service.list()[0]?.nextRunAt).toBe(iso(12, 1, 9))

    await vi.advanceTimersByTimeAsync(28 * 24 * 60 * 60_000)
    expect(startRun).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(2 * 24 * 60 * 60_000)
    expect(startRun).toHaveBeenCalledTimes(1)
    service.stop()
    await ctx.fiber.dispose()
  })

  it("runs now without moving the next run, and says when it can't", async () => {
    vi.useFakeTimers()
    vi.setSystemTime(local(11, 6, 8))
    const { ctx, project, service, startRun, listRuns } = await setup()
    service.start()
    const schedule = service.create({
      projectId: project.id,
      prompt: "standup",
      rule: { kind: "daily", time: "09:00" },
    })

    expect(await service.runNow(schedule.id)).toEqual({ status: "started", runId: "run_1" })
    expect(service.list()[0]).toMatchObject({ nextRunAt: iso(11, 6, 9), runCount: 1 })

    listRuns.mockReturnValue([{ runId: "run_1", threadId: startRun.mock.calls[0]![0] }])
    expect(await service.runNow(schedule.id)).toEqual({ status: "busy", runId: null })
    expect(service.runs(schedule.id).runs.map((run) => [run.source, run.status])).toEqual([
      ["manual", "skipped"],
      ["manual", "running"],
    ])
    service.stop()
    await ctx.fiber.dispose()
  })

  it("says the agent is unavailable when there is no runner", async () => {
    const { ctx, project, service } = await setup(":memory:", false)
    const schedule = service.create({
      projectId: project.id,
      prompt: "x",
      rule: { kind: "daily", time: "09:00" },
    })
    expect(await service.runNow(schedule.id)).toEqual({ status: "unavailable", runId: null })
    expect(service.runs(schedule.id).runs[0]).toMatchObject({
      status: "skipped",
      error: "AGENT_UNAVAILABLE",
    })
    await ctx.fiber.dispose()
  })

  it("shows each run's outcome from the runs table, pages the history and deletes a record", async () => {
    vi.useFakeTimers()
    vi.setSystemTime(local(11, 6, 8))
    const { ctx, project, service, startRun } = await setup()
    const schedule = service.create({
      projectId: project.id,
      prompt: "x",
      rule: { kind: "daily", time: "09:00" },
    })
    for (let index = 0; index < 3; index += 1) {
      vi.setSystemTime(local(11, 6, 8, index))
      await service.runNow(schedule.id)
    }
    const insert = ctx.storage.db.prepare(
      `INSERT INTO runs (id, thread_id, agent_session_id, status, started_at, completed_at,
        error_message) VALUES (?, ?, 'as_1', ?, ?, ?, ?)`,
    )
    insert.run(
      "run_1",
      startRun.mock.calls[0]![0],
      "completed",
      iso(11, 6, 8),
      iso(11, 6, 8, 3),
      null,
    )
    insert.run(
      "run_2",
      startRun.mock.calls[1]![0],
      "failed",
      iso(11, 6, 8, 1),
      iso(11, 6, 8, 2),
      "boom",
    )

    const page = service.runs(schedule.id, 2, 0)
    expect(page.total).toBe(3)
    expect(page.runs.map((run) => [run.runId, run.status])).toEqual([
      ["run_3", "running"],
      ["run_2", "failed"],
    ])
    expect(page.runs[1]).toMatchObject({ error: "boom", finishedAt: iso(11, 6, 8, 2) })
    const rest = service.runs(schedule.id, 2, 2)
    expect(rest.runs).toMatchObject([
      { runId: "run_1", status: "succeeded", finishedAt: iso(11, 6, 8, 3) },
    ])

    expect(service.deleteRun(rest.runs[0]!.id)).toBe(true)
    expect(service.runs(schedule.id).total).toBe(2)
    await ctx.fiber.dispose()
  })
})
