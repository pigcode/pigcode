import { randomUUID } from "node:crypto"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  mobileFeatures,
  mobileSummaryMaxItems,
  mobileSummaryMethods,
  mobileSummaryPreviewLimit,
  type MobileComputerSummaryResult,
  type RunStatus,
} from "@pigcode/contracts"
import { Context } from "cordis"
import { afterEach, describe, expect, it } from "vitest"
import { apply as agents } from "../agents/registry"
import { MemoryTransport } from "../rpc/memory-transport"
import { ThreadFeed } from "../rpc/thread-feed"
import { apply as projects } from "../services/projects"
import { apply as sessions } from "../services/sessions"
import { apply as settings } from "../services/settings"
import { apply as storage } from "../services/storage"
import { apply as threads } from "../services/threads"
import { PendingRequestStore } from "../storage/pending-request-store"
import { MobileComputerSummary } from "./computer-summary"
import { fingerprint, PairedDevices } from "./paired-devices"
import { MobileSidebarRpc } from "./sidebar-rpc"

const tempDirs: string[] = []
afterEach(() => {
  while (tempDirs.length > 0) rmSync(tempDirs.pop()!, { recursive: true, force: true })
})

const FINISHED = new Set<RunStatus>(["completed", "failed", "interrupted"])

function seedRun(
  ctx: Context,
  threadId: string,
  runId: string,
  status: RunStatus,
  updatedAt: string,
  read = false,
) {
  const completedAt = FINISHED.has(status) ? updatedAt : null
  ctx.storage.db
    .prepare(
      `INSERT INTO runs (id, thread_id, agent_session_id, status, started_at, completed_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .run(runId, threadId, `sess_${runId}`, status, updatedAt, completedAt)
  ctx.storage.db
    .prepare(`UPDATE threads SET updated_at = ?, last_run_id = ?, read_run_id = ? WHERE id = ?`)
    .run(updatedAt, runId, read ? runId : null, threadId)
}

async function createFixture(computerName = "Studio Mac") {
  const dataDir = mkdtempSync(join(tmpdir(), "pigcode-summary-"))
  tempDirs.push(dataDir)
  const ctx = new Context()
  await ctx.plugin(storage, { path: ":memory:" })
  await ctx.plugin(settings, { path: join(dataDir, "settings.json") })
  await ctx.plugin(projects)
  await ctx.plugin(threads)
  await ctx.plugin(sessions)
  await ctx.plugin(agents)

  const computerKey = Buffer.alloc(32, 9)
  const deviceKey = Buffer.alloc(32, 21).toString("base64url")
  const devices = new PairedDevices(ctx.settings)
  devices.save({
    publicKey: deviceKey,
    name: "iPhone 17 Pro",
    platform: "ios",
    lastConnectedAt: Date.now(),
  })

  const session = {
    computerKey,
    computerName,
    deviceKey,
    features: [...mobileFeatures],
    relayRevision: () => undefined,
  }
  const summary = new MobileComputerSummary(ctx, session, () => {})
  const pendingStore = new PendingRequestStore(ctx.storage.db)
  return { ctx, devices, computerKey, deviceKey, summary, pendingStore }
}

function callSummary(summary: MobileComputerSummary, params: unknown = {}, id: string = randomUUID()) {
  return summary.dispatch({ jsonrpc: "2.0", id, method: mobileSummaryMethods.summary, params })
}

describe("MobileComputerSummary", () => {
  it("computes mutually-exclusive counts, excludes archived/child/removed threads, and sorts deterministically", async () => {
    const { ctx, computerKey, summary, pendingStore } = await createFixture("Workstation")
    try {
      const project = ctx.projects.add("/tmp/pigcode-sum-main", "核心仓库")
      const removed = ctx.projects.add("/tmp/pigcode-sum-removed", "已移除项目")
      ctx.projects.remove(removed.id)

      const orphan = ctx.threads.create(removed.id, "已删项目会话", "fake")
      seedRun(ctx, orphan.id, "run_orphan", "failed", "2026-11-26T14:00:00.000Z")

      const archived = ctx.threads.create(project.id, "归档审批会话", "fake")
      seedRun(ctx, archived.id, "run_archived", "waiting-approval", "2026-11-26T14:00:00.000Z")
      ctx.threads.archive(archived.id)

      const approvalThread = ctx.threads.create(project.id, "等待命令审批", "fake", undefined, {
        id: "th_attn_new",
      })
      ctx.threads.setPinned(approvalThread.id, true)
      seedRun(ctx, approvalThread.id, "run_attn_new", "waiting-approval", "2026-11-26T12:00:00.000Z")
      // 同时有 question 和 approval 时优先选 approval
      pendingStore.create({
        id: "req_q_first",
        threadId: approvalThread.id,
        runId: "run_attn_new",
        kind: "question",
        agentRequestId: null,
        payload: { questions: [{ question: "先确认环境", options: [], multiSelect: false }] },
        createdAt: "2026-11-26T11:59:00.000Z",
      })
      pendingStore.create({
        id: "req_a_second",
        threadId: approvalThread.id,
        runId: "run_attn_new",
        kind: "approval",
        agentRequestId: null,
        payload: {
          toolName: "Bash",
          title: "执行单元测试",
          input: { command: "rm -rf /tmp/secret && echo SECRET_ENV" },
        },
        createdAt: "2026-11-26T12:00:00.000Z",
      })

      const subagent = ctx.threads.create(project.id, "子代理", "fake", approvalThread.id)
      seedRun(ctx, subagent.id, "run_sub", "failed", "2026-11-26T14:00:00.000Z")

      const questionThread = ctx.threads.create(project.id, "等待回答问题", "fake", undefined, {
        id: "th_attn_old",
      })
      seedRun(ctx, questionThread.id, "run_attn_old", "waiting-input", "2026-11-26T10:00:00.000Z")
      pendingStore.create({
        id: "req_q_only",
        threadId: questionThread.id,
        runId: "run_attn_old",
        kind: "question",
        agentRequestId: null,
        payload: {
          questions: [
            { question: "  是否需要\n顺便更新   文档？  ", header: "文档", options: [], multiSelect: false },
          ],
        },
        createdAt: "2026-11-26T10:00:00.000Z",
      })

      const failed = ctx.threads.create(project.id, "构建失败", "fake", undefined, { id: "th_failed" })
      seedRun(ctx, failed.id, "run_failed", "failed", "2026-11-26T13:00:00.000Z")

      const running = ctx.threads.create(project.id, "正在运行", "fake", undefined, { id: "th_running" })
      seedRun(ctx, running.id, "run_running", "running", "2026-11-26T13:30:00.000Z")

      const queued = ctx.threads.create(project.id, "排队中", "fake", undefined, { id: "th_queued" })
      seedRun(ctx, queued.id, "run_queued", "queued", "2026-11-26T13:20:00.000Z")

      const unreadB = ctx.threads.create(project.id, "未读 B", "fake", undefined, { id: "th_unread_b" })
      seedRun(ctx, unreadB.id, "run_unread_b", "completed", "2026-11-26T11:00:00.000Z")
      const unreadA = ctx.threads.create(project.id, "未读 A", "fake", undefined, { id: "th_unread_a" })
      seedRun(ctx, unreadA.id, "run_unread_a", "completed", "2026-11-26T11:00:00.000Z")

      const doneRead = ctx.threads.create(project.id, "已读完成", "fake", undefined, { id: "th_done" })
      seedRun(ctx, doneRead.id, "run_done", "completed", "2026-11-26T13:50:00.000Z", true)

      ctx.threads.create(project.id, "空闲会话", "fake", undefined, { id: "th_idle" })

      const result = callSummary(summary)
      expect(result.computerId).toBe(fingerprint(computerKey))
      expect(result.computerName).toBe("Workstation")
      expect(result.truncated).toBe(false)
      expect(result.counts).toEqual({ attention: 2, error: 1, unread: 2, working: 2, total: 9 })
      expect(result.items.map((item) => item.threadId)).toEqual([
        "th_attn_new",
        "th_attn_old",
        "th_failed",
        "th_unread_a",
        "th_unread_b",
      ])
      expect(result.items[0]).toMatchObject({
        threadId: "th_attn_new",
        projectName: "核心仓库",
        status: "waiting-approval",
        pendingKind: "approval",
        pendingPreview: "执行单元测试",
        pinned: true,
        agentName: "Fake Agent",
      })
      expect(result.items[1]).toMatchObject({
        threadId: "th_attn_old",
        pendingKind: "question",
        pendingPreview: "是否需要 顺便更新 文档？",
      })
      expect(JSON.stringify(result)).not.toContain("SECRET_ENV")
      expect(JSON.stringify(result)).not.toContain("rm -rf")
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it("sanitizes pendingPreview for ExitPlanMode, fallbacks, long questions, and ignores stale runs", async () => {
    const { ctx, summary, pendingStore } = await createFixture()
    try {
      const project = ctx.projects.add("/tmp/pigcode-sum-preview", "PreviewRepo")

      const plan = ctx.threads.create(project.id, "计划确认", "fake", undefined, { id: "th_plan" })
      seedRun(ctx, plan.id, "run_plan", "waiting-approval", "2026-11-26T12:03:00.000Z")
      pendingStore.create({
        id: "req_plan",
        threadId: plan.id,
        runId: "run_plan",
        kind: "approval",
        agentRequestId: null,
        payload: {
          toolName: "ExitPlanMode",
          title: "Ignored title",
          input: { plan: "PRIVATE_PLAN_TEXT" },
        },
        createdAt: "2026-11-26T12:03:00.000Z",
      })

      const tool = ctx.threads.create(project.id, "工具审批", "fake", undefined, { id: "th_tool" })
      seedRun(ctx, tool.id, "run_tool", "waiting-approval", "2026-11-26T12:02:00.000Z")
      pendingStore.create({
        id: "req_tool",
        threadId: tool.id,
        runId: "run_tool",
        kind: "approval",
        agentRequestId: null,
        payload: {
          toolName: "Bash",
          title: "   ",
          displayName: "  运行\t终端\n工具  ",
          input: { command: "export API_KEY=TOP_SECRET" },
        },
        createdAt: "2026-11-26T12:02:00.000Z",
      })

      const longQ = ctx.threads.create(project.id, "长提问", "fake", undefined, { id: "th_long_q" })
      seedRun(ctx, longQ.id, "run_long_q", "waiting-input", "2026-11-26T12:01:00.000Z")
      pendingStore.create({
        id: "req_long_q",
        threadId: longQ.id,
        runId: "run_long_q",
        kind: "question",
        agentRequestId: null,
        payload: {
          questions: [
            { question: `请确认部署方案\n${"细节".repeat(90)}`, header: "部署", options: [], multiSelect: false },
          ],
        },
        createdAt: "2026-11-26T12:01:00.000Z",
      })

      const stale = ctx.threads.create(project.id, "旧 run 忽略", "fake", undefined, { id: "th_stale" })
      seedRun(ctx, stale.id, "run_old", "completed", "2026-11-26T11:00:00.000Z", true)
      pendingStore.create({
        id: "req_stale",
        threadId: stale.id,
        runId: "run_old",
        kind: "approval",
        agentRequestId: null,
        payload: { toolName: "Bash", title: "过期审批", input: {} },
        createdAt: "2026-11-26T11:00:00.000Z",
      })
      seedRun(ctx, stale.id, "run_current", "waiting-approval", "2026-11-26T12:00:00.000Z")

      const result = callSummary(summary)
      const byId = new Map(result.items.map((item) => [item.threadId, item]))
      expect(byId.get("th_plan")?.pendingPreview).toBe("计划审批")
      expect(byId.get("th_tool")?.pendingPreview).toBe("运行 终端 工具")
      const longPreview = byId.get("th_long_q")?.pendingPreview ?? ""
      expect(longPreview.length).toBeLessThanOrEqual(mobileSummaryPreviewLimit)
      expect(longPreview.endsWith("…")).toBe(true)
      expect(longPreview).not.toContain("\n")
      expect(byId.get("th_stale")?.pendingKind).toBeUndefined()
      expect(byId.get("th_stale")?.pendingPreview).toBeUndefined()

      const serialized = JSON.stringify(result)
      expect(serialized).not.toContain("PRIVATE_PLAN_TEXT")
      expect(serialized).not.toContain("TOP_SECRET")
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it("enforces the 50-item cap and 48 KiB JSON frame budget with truncated: true", async () => {
    const { ctx, summary } = await createFixture()
    try {
      const shortProject = ctx.projects.add("/tmp/pigcode-sum-cap", "ShortProj")
      for (let i = 0; i < 55; i += 1) {
        const thread = ctx.threads.create(shortProject.id, `未读会话 ${i}`, "fake", undefined, {
          id: `th_cap_${String(i).padStart(2, "0")}`,
        })
        seedRun(ctx, thread.id, `run_cap_${i}`, "completed", `2026-11-26T10:${String(i).padStart(2, "0")}:00.000Z`)
      }
      const cappedByCount = callSummary(summary)
      expect(cappedByCount.counts.unread).toBe(55)
      expect(cappedByCount.counts.total).toBe(55)
      expect(cappedByCount.items).toHaveLength(mobileSummaryMaxItems)
      expect(cappedByCount.truncated).toBe(true)

      ctx.projects.remove(shortProject.id)
      const longProject = ctx.projects.add("/tmp/pigcode-sum-big", "项".repeat(500))
      for (let i = 0; i < 40; i += 1) {
        const thread = ctx.threads.create(longProject.id, `标${i}${"题".repeat(490)}`, "fake", undefined, {
          id: `th_big_${String(i).padStart(2, "0")}`,
        })
        seedRun(ctx, thread.id, `run_big_${i}`, "failed", `2026-11-26T11:${String(i).padStart(2, "0")}:00.000Z`)
      }

      const rpcId = "req-budget-check"
      const cappedByBytes = callSummary(summary, {}, rpcId)
      expect(cappedByBytes.counts.error).toBe(40)
      expect(cappedByBytes.truncated).toBe(true)
      expect(cappedByBytes.items.length).toBeGreaterThan(0)
      expect(cappedByBytes.items.length).toBeLessThan(40)
      const envelopeBytes = Buffer.byteLength(
        JSON.stringify({ jsonrpc: "2.0", id: rpcId, result: cappedByBytes }),
        "utf8",
      )
      expect(envelopeBytes).toBeLessThanOrEqual(48 * 1024)
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it("gates mobile.summary behind computer.summary feature and rejects revoked devices via MobileSidebarRpc", async () => {
    const { ctx, devices, computerKey, deviceKey } = await createFixture()
    try {
      const feed = new ThreadFeed(ctx)
      const wireLegacy = new MemoryTransport()
      const legacyRpc = new MobileSidebarRpc(ctx, feed, wireLegacy.host, devices, {
        computerKey,
        computerName: "LegacyMac",
        deviceKey,
        features: mobileFeatures.filter((feature) => feature !== "computer.summary"),
        relayRevision: () => undefined,
      })
      legacyRpc.start()
      wireLegacy.client.send({
        jsonrpc: "2.0",
        id: "m1",
        method: mobileSummaryMethods.summary,
        params: {},
      })
      expect(await wireLegacy.client.next()).toEqual(
        expect.objectContaining({
          id: "m1",
          error: expect.objectContaining({ code: "METHOD_NOT_AVAILABLE" }),
        }),
      )
      legacyRpc.stop()

      const wireModern = new MemoryTransport()
      const modernRpc = new MobileSidebarRpc(ctx, feed, wireModern.host, devices, {
        computerKey,
        computerName: "ModernMac",
        deviceKey,
        features: ["computer.summary"],
        relayRevision: () => undefined,
      })
      modernRpc.start()

      wireModern.client.send({
        jsonrpc: "2.0",
        id: "m2",
        method: mobileSummaryMethods.summary,
        params: {},
      })
      const okReply = (await wireModern.client.next()) as {
        id: string
        result: MobileComputerSummaryResult
      }
      expect(okReply.id).toBe("m2")
      expect(okReply.result.computerName).toBe("ModernMac")
      expect(okReply.result.counts.total).toBe(0)

      wireModern.client.send({
        jsonrpc: "2.0",
        id: "m3",
        method: mobileSummaryMethods.summary,
        params: { unexpected: 1 },
      })
      expect(await wireModern.client.next()).toEqual(
        expect.objectContaining({
          id: "m3",
          error: expect.objectContaining({ code: "INVALID_PARAMS" }),
        }),
      )

      devices.remove(devices.find(deviceKey)!)
      wireModern.client.send({
        jsonrpc: "2.0",
        id: "m4",
        method: mobileSummaryMethods.summary,
        params: {},
      })
      expect(await wireModern.client.next()).toEqual(
        expect.objectContaining({
          id: "m4",
          error: expect.objectContaining({ code: "DEVICE_REVOKED" }),
        }),
      )
      modernRpc.stop()
    } finally {
      await ctx.fiber.dispose()
    }
  })
})
