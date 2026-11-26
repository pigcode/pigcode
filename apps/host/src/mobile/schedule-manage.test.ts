import { randomUUID } from "node:crypto"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  mobileFeatures,
  mobileScheduleMethods,
  type MobileSchedule,
  type MobileScheduleDeleteResult,
  type MobileScheduleDeleteRunResult,
  type MobileScheduleListResult,
  type MobileScheduleRunNowResult,
  type MobileScheduleRunsResult,
} from "@pigcode/contracts"
import { Context } from "cordis"
import { afterEach, describe, expect, it, vi } from "vitest"
import { apply as agents } from "../agents/registry"
import { MemoryTransport } from "../rpc/memory-transport"
import { ThreadFeed } from "../rpc/thread-feed"
import { apply as projects } from "../services/projects"
import { SchedulesService, type ScheduleRunner } from "../services/schedules"
import { apply as sessions } from "../services/sessions"
import { apply as settings } from "../services/settings"
import { apply as storage } from "../services/storage"
import { apply as threads } from "../services/threads"
import { PairedDevices } from "./paired-devices"
import { MobileScheduleManage } from "./schedule-manage"
import { MobileSidebarRpc } from "./sidebar-rpc"

const tempDirs: string[] = []
afterEach(() => {
  while (tempDirs.length > 0) {
    rmSync(tempDirs.pop()!, { recursive: true, force: true })
  }
})

function makeTempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  tempDirs.push(dir)
  return dir
}

async function createScheduleFixture() {
  const dataDir = makeTempDir("pigcode-ms-data-")
  const ctx = new Context()
  await ctx.plugin(storage, { path: ":memory:" })
  await ctx.plugin(settings, { path: join(dataDir, "settings.json") })
  await ctx.plugin(projects)
  await ctx.plugin(threads)
  await ctx.plugin(sessions)
  await ctx.plugin(agents)

  let runCounter = 0
  const runner: ScheduleRunner = {
    createThread: vi.fn(async (target, title) =>
      ctx.threads.create(target.projectId, title, "fake", undefined, target.execution),
    ),
    startRun: vi.fn(async () => ({ runId: `run_${++runCounter}` })),
    listRuns: vi.fn(() => []),
  }
  const schedules = new SchedulesService(ctx.storage.db, () => runner)
  ctx.provide("schedules", schedules)

  const project = ctx.projects.add("/tmp/pigcode-mobile-schedule-proj", "核心项目")
  const manager = new MobileScheduleManage(ctx, () => {})
  return { ctx, schedules, project, runner, manager }
}

function callSchedule<T>(
  manager: MobileScheduleManage,
  method: string,
  params: unknown = {},
): Promise<T> {
  return manager.dispatch({ jsonrpc: "2.0", id: randomUUID(), method, params }) as Promise<T>
}

describe("MobileScheduleManage", () => {
  it("supports create, list without draft, update, runNow, runs pagination, deleteRun, and delete with desktop broadcast", async () => {
    const { ctx, schedules, project, manager } = await createScheduleFixture()
    try {
      const broadcasts: string[] = []
      const unsubscribe = schedules.subscribe((change) => broadcasts.push(change.scheduleId))

      const created = await callSchedule<MobileSchedule>(manager, mobileScheduleMethods.create, {
        projectId: project.id,
        title: "  每日巡检  ",
        prompt: "汇总今日变更",
        rule: { kind: "daily", time: "09:30" },
        execution: { permissionMode: "full-access" },
      })
      expect(created.title).toBe("每日巡检")
      expect(created.projectName).toBe("核心项目")
      expect(created.threadTitle).toBeNull()
      expect(created.enabled).toBe(true)
      expect("draft" in (created as Record<string, unknown>)).toBe(false)
      expect(broadcasts).toEqual([created.id])

      // 桌面端写入带 TipTap draft 的任务时，手机端 list 必须剥离 draft
      schedules.update(created.id, {
        draft: { document: '{"type":"doc","content":[]}' },
      })
      broadcasts.length = 0

      const listed = await callSchedule<MobileScheduleListResult>(
        manager,
        mobileScheduleMethods.list,
      )
      expect(listed.truncated).toBe(false)
      expect(listed.schedules).toHaveLength(1)
      expect("draft" in (listed.schedules[0] as Record<string, unknown>)).toBe(false)

      // Update schedule title, rule, enabled
      const updated = await callSchedule<MobileSchedule>(manager, mobileScheduleMethods.update, {
        id: created.id,
        title: "工作日巡检",
        rule: { kind: "weekdays", time: "10:00" },
        enabled: false,
      })
      expect(updated.title).toBe("工作日巡检")
      expect(updated.enabled).toBe(false)
      expect(updated.status).toBe("paused")
      expect(broadcasts).toContain(created.id)

      // Run now 3 times and verify pagination + deleteRun
      const run1 = await callSchedule<MobileScheduleRunNowResult>(
        manager,
        mobileScheduleMethods.runNow,
        { id: created.id },
      )
      expect(run1).toEqual({ status: "started", runId: "run_1" })
      await callSchedule(manager, mobileScheduleMethods.runNow, { id: created.id })
      await callSchedule(manager, mobileScheduleMethods.runNow, { id: created.id })

      const page1 = await callSchedule<MobileScheduleRunsResult>(
        manager,
        mobileScheduleMethods.runs,
        { id: created.id, limit: 2, offset: 0 },
      )
      expect(page1.total).toBe(3)
      expect(page1.runs).toHaveLength(2)

      const page2 = await callSchedule<MobileScheduleRunsResult>(
        manager,
        mobileScheduleMethods.runs,
        { id: created.id, limit: 2, offset: 2 },
      )
      expect(page2.total).toBe(3)
      expect(page2.runs).toHaveLength(1)

      const delRun = await callSchedule<MobileScheduleDeleteRunResult>(
        manager,
        mobileScheduleMethods.deleteRun,
        { id: page2.runs[0]!.id },
      )
      expect(delRun).toEqual({ deleted: true })
      const afterDelRun = await callSchedule<MobileScheduleRunsResult>(
        manager,
        mobileScheduleMethods.runs,
        { id: created.id },
      )
      expect(afterDelRun.total).toBe(2)

      // Delete broadcasts scheduleId to desktop subscribers
      broadcasts.length = 0
      const deleted = await callSchedule<MobileScheduleDeleteResult>(
        manager,
        mobileScheduleMethods.delete,
        { id: created.id },
      )
      expect(deleted).toEqual({ deleted: true })
      expect(broadcasts).toEqual([created.id])

      // Deleting missing schedule returns false and does not broadcast
      broadcasts.length = 0
      expect(
        await callSchedule<MobileScheduleDeleteResult>(manager, mobileScheduleMethods.delete, {
          id: created.id,
        }),
      ).toEqual({ deleted: false })
      expect(broadcasts).toEqual([])

      unsubscribe()
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it("rejects missing/archived project, unknown schedule id, and legacy schedule execution update", async () => {
    const { ctx, project, manager } = await createScheduleFixture()
    try {
      // Unknown project -> RESOURCE_NOT_AVAILABLE
      await expect(
        callSchedule(manager, mobileScheduleMethods.create, {
          projectId: "pr_missing",
          prompt: "hello",
          rule: { kind: "daily", time: "08:00" },
        }),
      ).rejects.toMatchObject({ code: "RESOURCE_NOT_AVAILABLE" })

      // Archived project -> RESOURCE_NOT_AVAILABLE
      const archived = ctx.projects.add("/tmp/pigcode-archived-proj", "已移除项目")
      ctx.projects.remove(archived.id)
      await expect(
        callSchedule(manager, mobileScheduleMethods.create, {
          projectId: archived.id,
          prompt: "hello",
          rule: { kind: "daily", time: "08:00" },
        }),
      ).rejects.toMatchObject({ code: "RESOURCE_NOT_AVAILABLE" })

      // Unknown schedule -> SCHEDULE_NOT_FOUND
      await expect(
        callSchedule(manager, mobileScheduleMethods.update, { id: "sch_missing", enabled: false }),
      ).rejects.toMatchObject({ code: "SCHEDULE_NOT_FOUND" })
      await expect(
        callSchedule(manager, mobileScheduleMethods.runNow, { id: "sch_missing" }),
      ).rejects.toMatchObject({ code: "SCHEDULE_NOT_FOUND" })
      await expect(
        callSchedule(manager, mobileScheduleMethods.runs, { id: "sch_missing" }),
      ).rejects.toMatchObject({ code: "SCHEDULE_NOT_FOUND" })

      // Legacy thread-bound schedule: list enriches threadTitle & projectName, execution update -> SCHEDULE_LEGACY_LOCKED
      const thread = ctx.threads.create(project.id, "历史会话标题", "fake")
      const at = "2026-11-26T00:00:00.000Z"
      ctx.storage.db
        .prepare(
          `INSERT INTO schedules (id, thread_id, title, prompt, rule_json, enabled, created_at, updated_at)
           VALUES ('sch_legacy', ?, '旧定时任务', 'legacy prompt', '{"kind":"daily","time":"09:00"}', 1, ?, ?)`,
        )
        .run(thread.id, at, at)

      const listed = await callSchedule<MobileScheduleListResult>(
        manager,
        mobileScheduleMethods.list,
      )
      expect(listed.schedules[0]).toMatchObject({
        id: "sch_legacy",
        projectName: "核心项目",
        threadTitle: "历史会话标题",
      })

      await expect(
        callSchedule(manager, mobileScheduleMethods.update, {
          id: "sch_legacy",
          execution: { permissionMode: "approval-required" },
        }),
      ).rejects.toMatchObject({ code: "SCHEDULE_LEGACY_LOCKED" })
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it("clips schedule list within the 48 KiB JSON frame budget and sets truncated", async () => {
    const { ctx, schedules, project, manager } = await createScheduleFixture()
    try {
      for (let i = 0; i < 8; i += 1) {
        schedules.create({
          projectId: project.id,
          title: `大任务 ${i}`,
          prompt: `任务内容-${i}-` + "x".repeat(10_000),
          rule: { kind: "daily", time: "09:00" },
        })
      }
      const listed = await callSchedule<MobileScheduleListResult>(
        manager,
        mobileScheduleMethods.list,
      )
      expect(listed.truncated).toBe(true)
      expect(listed.schedules.length).toBeGreaterThan(0)
      expect(listed.schedules.length).toBeLessThan(8)
      expect(Buffer.byteLength(JSON.stringify(listed), "utf8")).toBeLessThanOrEqual(48 * 1024)
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it("gates mobile.schedule.* behind schedules.manage feature in MobileSidebarRpc", async () => {
    const { ctx } = await createScheduleFixture()
    try {
      const devices = new PairedDevices(ctx.settings)
      const deviceKey = Buffer.alloc(32, 11).toString("base64url")
      devices.save({
        publicKey: deviceKey,
        name: "iPhone",
        platform: "ios",
        lastConnectedAt: Date.now(),
      })
      const wire = new MemoryTransport()
      const feed = new ThreadFeed(ctx)
      const rpc = new MobileSidebarRpc(ctx, feed, wire.host, devices, {
        computerKey: Buffer.alloc(32, 3),
        computerName: "TestMac",
        deviceKey,
        features: mobileFeatures.filter((f) => f !== "schedules.manage"),
        relayRevision: () => undefined,
      })
      rpc.start()

      wire.client.send({
        jsonrpc: "2.0",
        id: "s1",
        method: mobileScheduleMethods.list,
        params: {},
      })
      const reply = await wire.client.next()
      expect(reply).toEqual(
        expect.objectContaining({
          id: "s1",
          error: expect.objectContaining({ code: "METHOD_NOT_AVAILABLE" }),
        }),
      )
      rpc.stop()
    } finally {
      await ctx.fiber.dispose()
    }
  })
})
