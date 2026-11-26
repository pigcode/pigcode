import { spawn } from "node:child_process"
import { randomUUID } from "node:crypto"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createInterface } from "node:readline"
import { fileURLToPath } from "node:url"
import type { RunStatus } from "@pigcode/contracts"
import { Context } from "cordis"
import { describe, expect, it } from "vitest"
import { apply as agents } from "../agents/registry"
import { MemoryTransport } from "../rpc/memory-transport"
import { ThreadFeed } from "../rpc/thread-feed"
import { apply as projects } from "../services/projects"
import { apply as sessions } from "../services/sessions"
import { apply as settings } from "../services/settings"
import { apply as storage } from "../services/storage"
import { apply as threads } from "../services/threads"
import { PendingRequestStore } from "../storage/pending-request-store"
import { hasDartClientEnv } from "./dart-env"
import { mobileFrames } from "./mobile-frames"
import { fingerprint, PairedDevices } from "./paired-devices"
import { MobileSidebarRpc } from "./sidebar-rpc"

const MAX_NOISE_ENCRYPTED_FRAME_BYTES = 65_535
const NOISE_TAG_BYTES = 16
const FINISHED_STATUSES = new Set<RunStatus>(["completed", "failed", "interrupted"])

function assertSingleNoiseFrame(message: unknown): void {
  const frames = [...mobileFrames(message)]
  expect(frames).toHaveLength(1)
  expect(frames[0]!.length + NOISE_TAG_BYTES).toBeLessThanOrEqual(MAX_NOISE_ENCRYPTED_FRAME_BYTES)
}

function seedRun(
  ctx: Context,
  threadId: string,
  opts: { runId: string; status: RunStatus; updatedAt: string; read?: boolean },
) {
  const completedAt = FINISHED_STATUSES.has(opts.status) ? opts.updatedAt : null
  ctx.storage.db
    .prepare(
      `INSERT INTO runs (id, thread_id, agent_session_id, status, started_at, completed_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .run(opts.runId, threadId, `sess_${opts.runId}`, opts.status, opts.updatedAt, completedAt)
  ctx.storage.db
    .prepare(`UPDATE threads SET updated_at = ?, last_run_id = ?, read_run_id = ? WHERE id = ?`)
    .run(opts.updatedAt, opts.runId, opts.read ? opts.runId : null, threadId)
}

async function setupSummaryHost(root: string) {
  const ctx = new Context()
  await ctx.plugin(storage, { path: ":memory:" })
  await ctx.plugin(settings, { path: join(root, "settings.json") })
  await ctx.plugin(projects)
  await ctx.plugin(threads)
  await ctx.plugin(sessions)
  await ctx.plugin(agents)

  const pendingStore = new PendingRequestStore(ctx.storage.db)
  const project = ctx.projects.add(join(root, "repo"), "跨机联调仓库")
  const computerKey = Buffer.alloc(32, 13)
  const computerId = fingerprint(computerKey)
  const computerName = "Mac Studio 联调机"

  const tApproval = ctx.threads.create(project.id, "确认发布脚本", "fake", undefined, {
    id: "th_e2e_approval",
  })
  ctx.threads.setPinned(tApproval.id, true)
  seedRun(ctx, tApproval.id, {
    runId: "run_e2e_1",
    status: "waiting-approval",
    updatedAt: "2026-11-26T14:30:00.000Z",
  })
  pendingStore.create({
    id: "req_e2e_1",
    threadId: tApproval.id,
    runId: "run_e2e_1",
    kind: "approval",
    agentRequestId: null,
    payload: {
      toolName: "Bash",
      title: "运行发布前检查",
      input: { command: "SECRET_TOKEN=abc ./release.sh" },
    },
    createdAt: "2026-11-26T14:30:00.000Z",
  })

  const tPlan = ctx.threads.create(project.id, "确认架构计划", "fake", undefined, {
    id: "th_e2e_plan",
  })
  seedRun(ctx, tPlan.id, {
    runId: "run_e2e_2",
    status: "waiting-approval",
    updatedAt: "2026-11-26T14:20:00.000Z",
  })
  pendingStore.create({
    id: "req_e2e_2",
    threadId: tPlan.id,
    runId: "run_e2e_2",
    kind: "approval",
    agentRequestId: null,
    payload: { toolName: "ExitPlanMode", input: { plan: "internal plan details" } },
    createdAt: "2026-11-26T14:20:00.000Z",
  })

  const tQuestion = ctx.threads.create(project.id, "数据库迁移策略", "fake", undefined, {
    id: "th_e2e_question",
  })
  seedRun(ctx, tQuestion.id, {
    runId: "run_e2e_3",
    status: "waiting-input",
    updatedAt: "2026-11-26T14:10:00.000Z",
  })
  pendingStore.create({
    id: "req_e2e_3",
    threadId: tQuestion.id,
    runId: "run_e2e_3",
    kind: "question",
    agentRequestId: null,
    payload: {
      questions: [
        { question: "是否保留旧索引？", header: "索引", options: [], multiSelect: false },
      ],
    },
    createdAt: "2026-11-26T14:10:00.000Z",
  })

  const tFailed = ctx.threads.create(project.id, "CI 单测报错", "fake", undefined, {
    id: "th_e2e_failed",
  })
  seedRun(ctx, tFailed.id, {
    runId: "run_e2e_4",
    status: "failed",
    updatedAt: "2026-11-26T14:40:00.000Z",
    read: false,
  })

  const tUnread = ctx.threads.create(project.id, "代码审查结果", "fake", undefined, {
    id: "th_e2e_unread",
  })
  seedRun(ctx, tUnread.id, {
    runId: "run_e2e_5",
    status: "completed",
    updatedAt: "2026-11-26T14:50:00.000Z",
    read: false,
  })

  const tWorking = ctx.threads.create(project.id, "后台编译", "fake", undefined, {
    id: "th_e2e_working",
  })
  seedRun(ctx, tWorking.id, {
    runId: "run_e2e_6",
    status: "running",
    updatedAt: "2026-11-26T14:55:00.000Z",
  })

  const tDone = ctx.threads.create(project.id, "已读历史会话", "fake", undefined, {
    id: "th_e2e_done",
  })
  seedRun(ctx, tDone.id, {
    runId: "run_e2e_7",
    status: "completed",
    updatedAt: "2026-11-26T13:00:00.000Z",
    read: true,
  })

  const tArchived = ctx.threads.create(project.id, "已归档会话", "fake", undefined, {
    id: "th_e2e_archived",
  })
  seedRun(ctx, tArchived.id, {
    runId: "run_e2e_8",
    status: "failed",
    updatedAt: "2026-11-26T14:59:00.000Z",
    read: false,
  })
  ctx.threads.archive(tArchived.id)

  const devices = new PairedDevices(ctx.settings)
  const deviceKey = Buffer.alloc(32, 77).toString("base64url")
  devices.save({ publicKey: deviceKey, name: "Dart Summary", platform: "ios", lastConnectedAt: 1000 })

  const wire = new MemoryTransport()
  const feed = new ThreadFeed(ctx)
  const rpc = new MobileSidebarRpc(ctx, feed, wire.host, devices, {
    computerKey,
    computerName,
    deviceKey,
    features: ["sidebar.read", "sidebar.presentation", "computer.summary"],
    relayRevision: () => undefined,
  })
  rpc.start()

  return {
    ctx,
    computerId,
    computerName,
    wire,
    async dispose() {
      rpc.stop()
      await ctx.fiber.dispose()
    },
  }
}

describe.skipIf(!hasDartClientEnv())(
  "mobile computer summary Dart client end-to-end",
  { timeout: 30_000 },
  () => {
    it("fetches native mobile.summary and legacy sidebar fallback over single Noise frames", async () => {
      const root = await mkdtemp(join(tmpdir(), "pigcode-summary-dart-e2e-"))
      const host = await setupSummaryHost(root)

      const clientPkgDir = fileURLToPath(
        new URL("../../../mobile/packages/pigcode_client", import.meta.url),
      )
      const dart = spawn("dart", ["run", "test/computer_summary_e2e_driver.dart"], {
        cwd: clientPkgDir,
        stdio: ["pipe", "pipe", "pipe"],
      })
      dart.stdin.on("error", () => {})
      let stderr = ""
      dart.stderr.setEncoding("utf8").on("data", (chunk: string) => {
        stderr += chunk
      })

      let framesChecked = 0
      host.wire.client.onMessage((message) => {
        assertSingleNoiseFrame(message)
        framesChecked += 1
        if (!dart.killed) {
          dart.stdin.write(`${JSON.stringify({ dir: "rpc_msg", message })}\n`)
        }
      })

      const cmdPending = new Map<
        string,
        (res: { ok: boolean; data?: Record<string, unknown>; code?: string; error?: string }) => void
      >()
      const rl = createInterface({ input: dart.stdout })
      rl.on("line", (line) => {
        if (!line.trim()) return
        const msg = JSON.parse(line) as {
          dir: string
          id?: string
          method?: string
          params?: Record<string, unknown>
          cmdId?: string
          ok?: boolean
          data?: Record<string, unknown>
          code?: string
          error?: string
        }
        if (msg.dir === "rpc_req") {
          const req = { jsonrpc: "2.0", id: msg.id, method: msg.method, params: msg.params ?? {} }
          assertSingleNoiseFrame(req)
          framesChecked += 1
          host.wire.client.send(req)
        } else if (msg.dir === "cmd_res" && msg.cmdId) {
          const resolve = cmdPending.get(msg.cmdId)
          if (resolve) {
            cmdPending.delete(msg.cmdId)
            resolve({
              ok: msg.ok === true,
              ...(msg.data ? { data: msg.data } : {}),
              ...(msg.code ? { code: msg.code } : {}),
              ...(msg.error ? { error: msg.error } : {}),
            })
          }
        }
      })

      function runDart(action: string, args: Record<string, unknown>) {
        const cmdId = randomUUID()
        return new Promise<{
          ok: boolean
          data?: Record<string, unknown>
          code?: string
          error?: string
        }>((resolve) => {
          cmdPending.set(cmdId, resolve)
          dart.stdin.write(`${JSON.stringify({ dir: "cmd", cmdId, action, args })}\n`)
        })
      }

      try {
        // 1. 原生 mobile.summary 路径
        const nativeRes = await runDart("summary.fetch", {
          supportsComputerSummary: true,
          computerId: host.computerId,
          computerName: host.computerName,
        })
        expect(nativeRes.ok, stderr || nativeRes.error).toBe(true)
        expect(nativeRes.data).toMatchObject({
          computerId: host.computerId,
          computerName: host.computerName,
          truncated: false,
          counts: {
            attention: 3,
            error: 1,
            unread: 1,
            working: 1,
            total: 7,
          },
        })
        const nativeItems = nativeRes.data!.items as Array<Record<string, unknown>>
        expect(nativeItems.map((item) => item.threadId)).toEqual([
          "th_e2e_approval",
          "th_e2e_plan",
          "th_e2e_question",
          "th_e2e_failed",
          "th_e2e_unread",
        ])
        expect(nativeItems[0]).toMatchObject({
          pendingKind: "approval",
          pendingPreview: "运行发布前检查",
          pinned: true,
          projectName: "跨机联调仓库",
        })
        expect(nativeItems[1]).toMatchObject({
          pendingKind: "approval",
          pendingPreview: "计划审批",
        })
        expect(nativeItems[2]).toMatchObject({
          pendingKind: "question",
          pendingPreview: "是否保留旧索引？",
        })
        expect(JSON.stringify(nativeRes.data)).not.toContain("SECRET_TOKEN")

        // 2. 老桌面端降级路径（project.list + thread.list -> summarizeSidebarSnapshot）
        const fallbackRes = await runDart("summary.fetch", {
          supportsComputerSummary: false,
          computerId: host.computerId,
          computerName: host.computerName,
        })
        expect(fallbackRes.ok, stderr || fallbackRes.error).toBe(true)
        expect(fallbackRes.data).toMatchObject({
          computerId: host.computerId,
          computerName: host.computerName,
          truncated: false,
          counts: nativeRes.data!.counts,
        })
        const fallbackItems = fallbackRes.data!.items as Array<Record<string, unknown>>
        expect(fallbackItems.map((item) => item.threadId)).toEqual(
          nativeItems.map((item) => item.threadId),
        )
        expect(fallbackItems[0]?.pendingKind).toBe("approval")
        expect(fallbackItems[0]?.pendingPreview).toBeUndefined()

        expect(framesChecked).toBeGreaterThanOrEqual(10)
      } finally {
        dart.stdin.write(`${JSON.stringify({ dir: "shutdown" })}\n`)
        dart.stdin.end()
        await new Promise<void>((resolve) => {
          dart.once("exit", () => resolve())
          setTimeout(() => {
            dart.kill("SIGKILL")
            resolve()
          }, 2000)
        })
        rl.close()
        await host.dispose()
        await rm(root, { recursive: true, force: true })
      }
    })
  },
)
