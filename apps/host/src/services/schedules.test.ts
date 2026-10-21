/** 验证定时任务服务：间隔触发、忙时跳过、重启恢复与删除。 */
import { Context } from "cordis"
import { afterEach, describe, expect, it, vi } from "vitest"
import { apply as projects } from "./projects"
import { SchedulesService, type ScheduleRunner } from "./schedules"
import { apply as storage } from "./storage"
import { apply as threads } from "./threads"

/** 建立内存 Host，线程用于满足 schedules.thread_id 外键。 */
async function setup() {
  const ctx = new Context()
  await ctx.plugin(storage, { path: ":memory:" })
  await ctx.plugin(projects)
  await ctx.plugin(threads)
  const project = ctx.projects.add("/tmp/pigcode-schedules")
  const thread = ctx.threads.create(project.id, "Scheduled", "fake")
  let counter = 0
  const startRun = vi.fn(async () => ({ runId: `run_${++counter}` }))
  const listRuns = vi.fn((): Array<{ threadId: string }> => [])
  const runner: ScheduleRunner = { startRun, listRuns }
  const service = new SchedulesService(ctx.storage.db, () => runner)
  return { ctx, thread, service, runner, startRun, listRuns }
}

afterEach(() => {
  vi.useRealTimers()
})

describe("SchedulesService", () => {
  it("starts a run once per 60 second interval", async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date("2026-10-20T00:00:00.000Z"))
    const { ctx, thread, service, startRun } = await setup()
    service.start()
    const schedule = service.create({
      threadId: thread.id,
      prompt: "summarize",
      intervalSeconds: 60,
      enabled: true,
    })
    expect(schedule.nextRunAt).toBe("2026-10-20T00:01:00.000Z")

    await vi.advanceTimersByTimeAsync(60_000)

    expect(startRun).toHaveBeenCalledTimes(1)
    expect(startRun).toHaveBeenCalledWith(thread.id, "summarize")
    const updated = service.list()[0]
    expect(updated?.lastRunAt).toBe("2026-10-20T00:01:00.000Z")
    expect(updated?.lastRunId).toBe("run_1")
    expect(updated?.nextRunAt).toBe("2026-10-20T00:02:00.000Z")

    await vi.advanceTimersByTimeAsync(60_000)
    expect(startRun).toHaveBeenCalledTimes(2)

    service.stop()
    await ctx.fiber.dispose()
  })

  it("skips a busy thread and only moves next_run_at", async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date("2026-10-20T00:00:00.000Z"))
    const { ctx, thread, service, startRun, listRuns } = await setup()
    listRuns.mockReturnValue([{ threadId: thread.id }])
    service.start()
    service.create({
      threadId: thread.id,
      prompt: "summarize",
      intervalSeconds: 60,
      enabled: true,
    })

    await vi.advanceTimersByTimeAsync(60_000)

    expect(startRun).not.toHaveBeenCalled()
    const updated = service.list()[0]
    expect(updated?.lastRunAt).toBeNull()
    expect(updated?.lastRunId).toBeNull()
    expect(updated?.nextRunAt).toBe("2026-10-20T00:02:00.000Z")

    service.stop()
    await ctx.fiber.dispose()
  })

  it("restores schedules and their next_run_at from the same database", async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date("2026-10-20T00:00:00.000Z"))
    const { ctx, thread, service, runner, startRun } = await setup()
    service.start()
    service.create({
      threadId: thread.id,
      prompt: "summarize",
      intervalSeconds: 60,
      enabled: true,
    })
    service.stop()

    const restored = new SchedulesService(ctx.storage.db, () => runner)
    expect(restored.list()[0]?.nextRunAt).toBe("2026-10-20T00:01:00.000Z")
    restored.start()
    await vi.advanceTimersByTimeAsync(60_000)

    expect(startRun).toHaveBeenCalledTimes(1)

    restored.stop()
    await ctx.fiber.dispose()
  })

  it("catches up an overdue schedule exactly once after start", async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date("2026-10-20T00:00:00.000Z"))
    const { ctx, thread, service, runner, startRun } = await setup()
    service.start()
    service.create({
      threadId: thread.id,
      prompt: "summarize",
      intervalSeconds: 60,
      enabled: true,
    })
    service.stop()

    vi.setSystemTime(new Date("2026-10-20T00:05:00.000Z"))
    const restored = new SchedulesService(ctx.storage.db, () => runner)
    restored.start()
    await vi.advanceTimersByTimeAsync(0)
    expect(startRun).toHaveBeenCalledTimes(1)

    const updated = restored.list()[0]
    expect(updated?.lastRunAt).toBe("2026-10-20T00:05:00.000Z")
    expect(updated?.nextRunAt).toBe("2026-10-20T00:06:00.000Z")

    restored.stop()
    await ctx.fiber.dispose()
  })

  it("does not fire after the schedule is deleted", async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date("2026-10-20T00:00:00.000Z"))
    const { ctx, thread, service, startRun } = await setup()
    service.start()
    const schedule = service.create({
      threadId: thread.id,
      prompt: "summarize",
      intervalSeconds: 60,
      enabled: true,
    })

    expect(service.delete(schedule.id)).toBe(true)
    expect(service.list()).toEqual([])
    await vi.advanceTimersByTimeAsync(120_000)
    expect(startRun).not.toHaveBeenCalled()
    expect(service.delete(schedule.id)).toBe(false)

    service.stop()
    await ctx.fiber.dispose()
  })
})
