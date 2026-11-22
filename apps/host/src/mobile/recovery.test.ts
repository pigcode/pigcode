import { spawn } from "node:child_process"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createInterface } from "node:readline"
import { fileURLToPath } from "node:url"
import { mobilePairingViewSchema, rpcSuccessSchema } from "@pigcode/contracts"
import { expect, it } from "vitest"
import { FAKE_APPROVAL_TEXT, FakeAgentDriver } from "../agents/fake"
import { startMobileHost } from "../rpc/mobile-test-fixture"

const address = process.env.PIGCODE_RELAY_TEST_URL
const token = process.env.PIGCODE_RELAY_TEST_TOKEN

it.skipIf(!address || !token)(
  "reconnects over Go WSS, fills multiple missed pages, and clears a pending request after a Host restart",
  async () => {
    const dir = await mkdtemp(join(tmpdir(), "pigcode-mobile-recovery-"))
    const settingsPath = join(dir, "settings.json")
    const storagePath = join(dir, "host.db")
    const restartPath = join(dir, "crash-snapshot.db")
    const createdAt = new Date().toISOString()
    let threadId = ""
    let host = await startMobileHost({
      settingsPath,
      storagePath,
      prepare(ctx) {
        ctx.agents.register(new FakeAgentDriver())
        const project = ctx.projects.add(dir, "恢复验收")
        threadId = ctx.threads.create(project.id, "等待审批的会话", "fake").id
        for (const runId of ["first", "second"]) {
          for (const type of ["run.started", "run.completed"] as const) {
            ctx.sessions.append({ threadId, runId, type, createdAt, schemaVersion: 1, payload: {} })
          }
        }
      },
    })
    const phone = spawn("dart", ["run", "scripts/verify-device-management.dart"], {
      cwd: fileURLToPath(new URL("../../../mobile", import.meta.url)),
      stdio: ["pipe", "pipe", "pipe"],
    })
    let diagnostic = ""
    phone.stderr.setEncoding("utf8").on("data", (chunk: string) => (diagnostic += chunk))
    phone.on("error", (error) => (diagnostic += error.message))
    const lines = createInterface({ input: phone.stdout })[Symbol.asyncIterator]()
    function send(action: string, params: Record<string, unknown> = {}) {
      phone.stdin.write(JSON.stringify({ phone: "个人 iPhone", action, ...params }) + "\n")
    }
    async function receive() {
      const line = await lines.next()
      if (line.done) throw new Error(diagnostic || "Dart verifier exited early")
      return JSON.parse(line.value) as {
        stage: string
        code?: string
        through?: number
        cursor?: number
        events?: number[]
      }
    }
    async function mobile(action: string, params?: Record<string, unknown>) {
      send(action, params)
      return receive()
    }
    async function desktop(method: string, params: Record<string, unknown> = {}) {
      return rpcSuccessSchema.parse(await host.call(method, params)).result
    }

    try {
      await desktop("relay.testAndSave", { address, token })
      expect(await desktop("mobile.pairing.start")).toMatchObject({ status: "waiting" })
      host.ctx.mobileConnections.setSuspended(true)
      expect(await desktop("mobile.pairing")).toMatchObject({ status: "cancelled", attempt: null })
      host.ctx.mobileConnections.setSuspended(false)
      const { attempt } = mobilePairingViewSchema.parse(await desktop("mobile.pairing.start"))
      if (!attempt?.qr) throw new Error("missing pairing QR")
      send("pair", { qr: attempt.qr })
      const code = await receive()
      const candidate = mobilePairingViewSchema.parse(await desktop("mobile.pairing")).attempt?.candidate
      expect(candidate?.code).toBe(code.code)
      await desktop("mobile.pairing.confirm", { id: attempt.id, confirmation: candidate?.confirmation })
      expect(await receive()).toEqual({ stage: "ready" })
      expect(await mobile("save")).toEqual({ stage: "saved" })
      expect(await mobile("watchComputer")).toMatchObject({
        stage: "computerState",
        state: "online",
        lastOnlineAt: expect.any(String),
      })

      const { runId } = (await desktop("run.start", { threadId, text: FAKE_APPROVAL_TEXT })) as {
        runId: string
      }
      expect(await mobile("pendingRequests", { threadId, count: 1 })).toMatchObject({
        stage: "pending",
        requests: [expect.any(Object)],
      })
      expect(await mobile("sidebar", { threadId, status: "waiting-approval" })).toMatchObject({
        threads: [expect.objectContaining({ id: threadId, status: "waiting-approval" })],
      })
      const before = await mobile("captureRecovery", { threadId })
      expect(before).toMatchObject({ stage: "recovery", pending: 1, hasLive: true })
      expect(before.events?.[0]).toBe(1)

      // Use the same suspend/resume entry used by the desktop power monitor.
      host.ctx.mobileConnections.setSuspended(true)
      expect(await mobile("computerState")).toMatchObject({ state: "sleeping", lastOnlineAt: expect.any(String) })
      expect(await mobile("closed")).toEqual({ stage: "closed" })
      const missed = Array.from({ length: 510 }, (_, index) => host.ctx.sessions.append({
        threadId,
        runId,
        type: "reasoning.completed",
        payload: { text: "离线记录 " + index },
        schemaVersion: 1,
        createdAt,
      }).seq)
      host.ctx.mobileConnections.setSuspended(false)
      expect(await mobile("computerState")).toMatchObject({ state: "online" })
      expect(await mobile("reconnect")).toEqual({ stage: "ready" })
      expect(await mobile("sidebar", { threadId, status: "waiting-approval" })).toMatchObject({
        threads: [expect.objectContaining({ id: threadId, status: "waiting-approval" })],
      })
      const awake = await mobile("resumeRecovery", { threadId })
      expect(awake).toMatchObject({
        through: before.through,
        cursor: missed.at(-1),
        events: [...before.events!, ...missed],
        pending: 1,
      })

      // SQLite backup includes the committed WAL state before graceful cleanup.
      await host.ctx.storage.db.backup(restartPath)
      host.ctx.mobileConnections.announceExit("restarting")
      expect(await mobile("computerState")).toMatchObject({ state: "restarting" })
      expect(await mobile("closed")).toEqual({ stage: "closed" })
      await host.stop()

      host = await startMobileHost({
        settingsPath,
        storagePath: restartPath,
        prepare(ctx) {
          expect(ctx.agents.recoverAfterRestart()).toEqual({
            orphanedRequests: 1,
            interruptedRuns: 1,
            orphanedSessions: 1,
          })
        },
      })
      expect(await mobile("computerState")).toMatchObject({ state: "online" })
      expect(await mobile("reconnect")).toEqual({ stage: "ready" })
      expect(await desktop("thread.list")).toContainEqual(expect.objectContaining({ id: threadId, status: "interrupted" }))
      expect(await mobile("sidebar", { threadId, status: "interrupted" })).toMatchObject({
        threads: [expect.objectContaining({ id: threadId, status: "interrupted" })],
      })
      const after = await mobile("resumeRecovery", { threadId })
      expect(after).toMatchObject({
        through: before.through,
        cursor: awake.cursor! + 2,
        events: [...awake.events!, awake.cursor! + 1, awake.cursor! + 2],
        ends: ["notice", "run.interrupted"],
        lastText: "电脑上的 Pigcode 重启，运行已中断。",
        pending: 0,
        hasLive: false,
      })
    } finally {
      phone.stdin.end()
      phone.kill()
      await host.stop()
      await rm(dir, { recursive: true, force: true })
    }
  },
  45_000,
)
