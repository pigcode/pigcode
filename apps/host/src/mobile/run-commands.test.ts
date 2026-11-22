import { spawn } from "node:child_process"
import { randomUUID } from "node:crypto"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createInterface } from "node:readline"
import { fileURLToPath } from "node:url"
import { mobilePairingViewSchema, rpcSuccessSchema, type ThreadEvent } from "@pigcode/contracts"
import { Context } from "cordis"
import { expect, it } from "vitest"
import type { AgentDriver, CreateSessionInput } from "../agents/driver"
import { FakeAgentDriver } from "../agents/fake"
import { apply as agents } from "../agents/registry"
import { MemoryTransport } from "../rpc/memory-transport"
import { startMobileHost } from "../rpc/mobile-test-fixture"
import { ThreadFeed } from "../rpc/thread-feed"
import { apply as projects } from "../services/projects"
import { apply as sessions } from "../services/sessions"
import { apply as settings } from "../services/settings"
import { apply as storage } from "../services/storage"
import { apply as threads } from "../services/threads"
import { PairedDevices } from "./paired-devices"
import { MobileSidebarRpc } from "./sidebar-rpc"

it("binds a receipt to one command and rolls back the send when the receipt cannot be written", async () => {
  const ctx = new Context()
  await ctx.plugin(storage, { path: ":memory:" })
  await ctx.plugin(settings, {})
  await ctx.plugin(projects)
  await ctx.plugin(threads)
  await ctx.plugin(sessions)
  await ctx.plugin(agents)
  const project = ctx.projects.add("/tmp/pigcode-mobile-run-test", "命令测试")
  const thread = ctx.threads.create(project.id, "目标", "fake")
  const other = ctx.threads.create(project.id, "另一条会话", "fake")
  const deviceKey = Buffer.alloc(32, 2).toString("base64url")
  const devices = new PairedDevices(ctx.settings)
  devices.save({ publicKey: deviceKey, name: "验收手机", platform: "ios", lastConnectedAt: 1000 })
  const wire = new MemoryTransport()
  const session = new MobileSidebarRpc(ctx, new ThreadFeed(ctx), wire.host, devices, {
    computerKey: Buffer.alloc(32, 1),
    computerName: "测试电脑",
    deviceKey,
    features: ["run.write"],
    relayRevision: () => undefined,
  })
  session.start()

  async function call(method: string, params: Record<string, unknown>) {
    const id = randomUUID()
    wire.client.send({ jsonrpc: "2.0", id, method, params })
    const reply = await wire.client.next()
    expect(reply).toMatchObject({ id })
    return reply
  }

  try {
    const commandId = randomUUID()
    const send = { commandId, threadId: thread.id, text: "手机发送的正文" }
    const accepted = await call("run.start", send)
    expect(accepted).toMatchObject({
      result: { method: "run.start", commandId, threadId: thread.id, runId: expect.any(String) },
    })
    const { result } = accepted as { result: { runId: string } }
    expect(await call("run.start", send)).toMatchObject({ result })
    expect(await call("command.receipt", { commandId })).toMatchObject({
      result: { receipt: result },
    })
    expect(await call("run.start", { ...send, text: "修改后的正文" })).toMatchObject({
      error: { code: "COMMAND_ID_CONFLICT" },
    })
    expect(
      await call("run.interrupt", {
        commandId: randomUUID(),
        threadId: other.id,
        runId: result.runId,
      }),
    ).toMatchObject({ error: { code: "RESOURCE_NOT_AVAILABLE" } })
    expect(
      ctx.sessions
        .read(thread.id, 0)
        .filter(
          (event) =>
            event.type === "message.completed" &&
            (event.payload as { role: string }).role === "user",
        ),
    ).toHaveLength(1)

    const retry = { commandId: randomUUID(), threadId: other.id, text: "重试原文" }
    ctx.threads.archive(other.id)
    ctx.storage.db.exec(`CREATE TRIGGER reject_receipt BEFORE INSERT ON command_receipts
      BEGIN SELECT RAISE(ABORT, 'fixture receipt write failed'); END`)
    expect(await call("run.start", retry)).toMatchObject({
      error: { code: "COMMAND_FAILED" },
    })
    expect(ctx.sessions.read(other.id, 0)).toEqual([])
    expect(ctx.threads.get(other.id)?.archivedAt).toBeTruthy()
    expect(ctx.agents.listRuns().filter((run) => run.threadId === other.id)).toEqual([])
    expect(await call("command.receipt", { commandId: retry.commandId })).toMatchObject({
      result: {},
    })
    ctx.storage.db.exec("DROP TRIGGER reject_receipt")
    expect(await call("run.start", retry)).toMatchObject({ result: startReceipt(retry) })
    expect(ctx.threads.get(other.id)?.archivedAt).toBeNull()
  } finally {
    session.stop()
    ctx.agents.cancelAll()
    await ctx.fiber.dispose()
  }
})

function startReceipt({ commandId, threadId }: { commandId: string; threadId: string }) {
  return { method: "run.start", commandId, threadId, runId: expect.any(String) }
}

const address = process.env.PIGCODE_RELAY_TEST_URL
const token = process.env.PIGCODE_RELAY_TEST_TOKEN

it.skipIf(!address || !token)(
  "sends and stops a run over Go WSS and recovers the same command receipt in Dart",
  async () => {
    const temp = await mkdtemp(join(tmpdir(), "pigcode-mobile-commands-"))
    const paths = { settingsPath: join(temp, "settings.json"), storagePath: join(temp, "host.db") }
    const inputs: CreateSessionInput[] = []
    const delivered: string[] = []
    const desktopEvents: ThreadEvent[] = []
    const holdText = "请稍等，验证停止"
    const answer = "已收到手机消息"
    const liveText = "正在等待停止"
    let releaseFirst!: () => void
    let releaseAnother!: () => void
    const firstLaunch = new Promise<void>((resolve) => (releaseFirst = resolve))
    const anotherLaunch = new Promise<void>((resolve) => (releaseAnother = resolve))
    let threadId = ""
    let anotherThreadId = ""
    let instanceId = ""
    const driver: AgentDriver = {
      id: "mobile-command-fixture",
      displayName: "Mobile command fixture",
      features: new FakeAgentDriver().features,
      executionModes: { plan: true },
      requiresInstance: true,
      async createSession(input) {
        inputs.push(input)
        await firstLaunch
        if (input.threadId === anotherThreadId) await anotherLaunch
        return {
          id: input.sessionId ?? "mobile-command-session",
          threadId: input.threadId,
          cwd: input.cwd,
          nativeSessionId: null,
          permissionMode: input.permissionMode ?? "workspace-write",
          model: input.model ?? null,
        }
      },
      async send(_session, input, runtime) {
        delivered.push(input.text)
        if (input.text === holdText) {
          runtime.emit({ type: "message.delta", text: liveText })
          if (!runtime.signal.aborted) {
            await new Promise<void>((resolve) => {
              runtime.signal.addEventListener("abort", () => resolve(), { once: true })
            })
          }
          return
        }
        runtime.emit({ type: "message.completed", text: answer })
        runtime.emit({ type: "run.completed" })
      },
      interrupt: async () => undefined,
      dispose: async () => undefined,
    }
    let failStopWrite!: (enabled: boolean) => void
    const agentConfig = { dataDir: join(temp, "agents"), maxConcurrentRuns: 1 }
    function collectDesktopEvents(message: unknown) {
      const notification = message as { method?: string; params: ThreadEvent }
      if (notification.method === "thread.event") desktopEvents.push(notification.params)
    }
    let host = await startMobileHost({
      ...paths,
      agentConfig,
      prepare(ctx) {
        ctx.agents.register(driver)
        failStopWrite = (enabled) => {
          ctx.storage.db.exec(
            enabled
              ? `CREATE TRIGGER reject_stop BEFORE INSERT ON thread_events
                 WHEN NEW.type = 'run.interrupted'
                 BEGIN SELECT RAISE(ABORT, 'fixture stop write failed'); END`
              : "DROP TRIGGER reject_stop",
          )
        }
        instanceId = ctx.agents.createInstance(driver.id, "验收实例").instanceId
        const project = ctx.projects.add(temp, "发消息验收")
        threadId = ctx.threads.create(project.id, "目标", driver.id, undefined, {
          instanceId,
          modelId: "fixture-model",
          permissionMode: "approval-required",
        }).id
        anotherThreadId = ctx.threads.create(project.id, "另一会话", driver.id, undefined, {
          instanceId,
        }).id
      },
      onDesktopMessage: collectDesktopEvents,
    })
    const phone = spawn("dart", ["run", "scripts/verify-device-management.dart"], {
      cwd: fileURLToPath(new URL("../../../mobile", import.meta.url)),
      env: process.env,
      stdio: ["pipe", "pipe", "pipe"],
    })
    let diagnostics = ""
    phone.stderr.setEncoding("utf8").on("data", (chunk: string) => (diagnostics += chunk))
    phone.on("error", (error) => (diagnostics += error.message))
    const lines = createInterface({ input: phone.stdout })[Symbol.asyncIterator]()
    function send(action: string, params: Record<string, string> = {}) {
      phone.stdin.write(JSON.stringify({ phone: "个人 iPhone", action, ...params }) + "\n")
    }
    async function receive() {
      const entry = await lines.next()
      if (entry.done) throw new Error(diagnostics || "Dart verification exited early")
      return JSON.parse(entry.value) as {
        stage: string
        code?: string
        receipt?: { runId: string }
      }
    }
    async function phoneCall(action: string, params?: Record<string, string>) {
      send(action, params)
      return receive()
    }
    async function call(method: string, params?: Record<string, unknown>) {
      return rpcSuccessSchema.parse(await host.call(method, params)).result
    }

    try {
      await call("relay.testAndSave", { address, token })
      await call("thread.subscribe", { threadId, cursor: 0 })
      const { attempt } = mobilePairingViewSchema.parse(await call("mobile.pairing.start"))
      if (!attempt?.qr) throw new Error("missing pairing QR")
      send("pair", { qr: attempt.qr })
      const code = await receive()
      const candidate = mobilePairingViewSchema.parse(await call("mobile.pairing")).attempt
        ?.candidate
      expect(candidate?.code).toBe(code.code)
      await call("mobile.pairing.confirm", {
        id: attempt.id,
        confirmation: candidate?.confirmation,
      })
      expect(await receive()).toEqual({ stage: "ready" })
      expect(await phoneCall("save")).toEqual({ stage: "saved" })

      const sendCommand = { commandId: randomUUID(), threadId, text: "  来自手机\n保留空格  " }
      expect(await phoneCall("startWithoutReply", sendCommand)).toEqual({ stage: "waiting" })
      const submitted = (text: string) =>
        desktopEvents.filter(
          (event) =>
            event.type === "message.completed" &&
            (event.payload as { role?: string; text?: string }).role === "user" &&
            (event.payload as { text?: string }).text === text,
        )
      await expect.poll(() => submitted(sendCommand.text), { timeout: 5000 }).toHaveLength(1)
      expect(await phoneCall("disconnect")).toEqual({ stage: "closed" })
      releaseFirst()
      expect(await phoneCall("reconnect")).toEqual({ stage: "ready" })
      const accepted = await phoneCall("lookupCommand", { commandId: sendCommand.commandId })
      expect(accepted).toMatchObject({ stage: "command", receipt: startReceipt(sendCommand) })
      expect(await phoneCall("startCommand", sendCommand)).toEqual(accepted)
      expect(await phoneCall("timeline", { threadId, answer })).toMatchObject({ hasAnswer: true })
      expect(submitted(sendCommand.text)).toHaveLength(1)
      expect(inputs).toMatchObject([
        {
          threadId,
          instance: { instanceId },
          model: "fixture-model",
          permissionMode: "approval-required",
        },
      ])

      const active = await phoneCall("startCommand", {
        commandId: randomUUID(),
        threadId,
        text: holdText,
      })
      expect(active).toMatchObject({ stage: "command", receipt: { runId: expect.any(String) } })
      const stop = { commandId: randomUUID(), threadId, runId: active.receipt!.runId }
      expect(await phoneCall("timeline", { threadId, liveText })).toMatchObject({ liveText })
      expect(await phoneCall("stopCommand", { ...stop, threadId: anotherThreadId })).toEqual({
        stage: "failed",
        code: "RESOURCE_NOT_AVAILABLE",
      })
      failStopWrite(true)
      try {
        expect(await phoneCall("stopCommand", stop)).toEqual({
          stage: "failed",
          code: "COMMAND_FAILED",
        })
        expect(await phoneCall("lookupCommand", { commandId: stop.commandId })).toEqual({
          stage: "command",
          receipt: null,
        })
        expect(await phoneCall("timeline", { threadId, liveText })).toMatchObject({ liveText })
      } finally {
        failStopWrite(false)
      }
      const stopped = await phoneCall("stopCommand", stop)
      expect(stopped).toEqual({ stage: "command", receipt: { method: "run.interrupt", ...stop } })
      expect(await phoneCall("stopCommand", stop)).toEqual(stopped)
      expect(await phoneCall("timeline", { threadId, stoppedRunId: stop.runId })).toMatchObject({
        stopped: true,
      })
      expect(
        desktopEvents.filter(
          (event) => event.type === "run.interrupted" && event.runId === stop.runId,
        ),
      ).toMatchObject([{ threadId }])

      await call("thread.subscribe", { threadId: anotherThreadId, cursor: 0 })
      const starting = { commandId: randomUUID(), threadId: anotherThreadId, text: "启动时停止" }
      expect(await phoneCall("startWithoutReply", starting)).toEqual({ stage: "waiting" })
      await expect.poll(() => submitted(starting.text)).toHaveLength(1)
      const startingReceipt = await phoneCall("lookupCommand", { commandId: starting.commandId })
      expect(startingReceipt).toMatchObject({ receipt: startReceipt(starting) })
      const startingRunId = startingReceipt.receipt!.runId
      expect(
        await phoneCall("stopCommand", {
          commandId: randomUUID(),
          threadId: anotherThreadId,
          runId: startingRunId,
        }),
      ).toMatchObject({ stage: "command" })
      expect(
        await phoneCall("timeline", {
          threadId: anotherThreadId,
          stoppedRunId: startingRunId,
        }),
      ).toMatchObject({ stopped: true })
      releaseAnother()

      expect(await phoneCall("disconnect")).toEqual({ stage: "closed" })
      await host.stop()
      host = await startMobileHost({
        ...paths,
        agentConfig,
        prepare: (ctx) => ctx.agents.register(driver),
        onDesktopMessage: collectDesktopEvents,
      })
      // The restarted Host registers with Go asynchronously from its saved settings.
      await expect.poll(() => phoneCall("reconnect"), { timeout: 8000 }).toEqual({ stage: "ready" })
      expect(await phoneCall("lookupCommand", { commandId: sendCommand.commandId })).toEqual(
        accepted,
      )
      expect(await phoneCall("lookupCommand", { commandId: stop.commandId })).toEqual(stopped)
      expect(delivered).not.toContain(starting.text)

      await call("thread.subscribe", { threadId: anotherThreadId, cursor: 0 })
      const running = await phoneCall("startCommand", {
        commandId: randomUUID(),
        threadId,
        text: holdText,
      })
      expect(running).toMatchObject({ stage: "command", receipt: { runId: expect.any(String) } })
      expect(await phoneCall("timeline", { threadId, liveText })).toMatchObject({ liveText })
      const queuedText = "撤销设备后取消这条排队消息"
      const queued = await phoneCall("startCommand", {
        commandId: randomUUID(),
        threadId: anotherThreadId,
        text: queuedText,
      })
      const queuedRunId = queued.receipt!.runId
      const paired = mobilePairingViewSchema.parse(await call("mobile.pairing"))
      expect(
        await call("mobile.devices.revoke", { deviceId: paired.devices[0]!.id }),
      ).toMatchObject({
        status: "revoked",
      })
      expect(await phoneCall("closed")).toEqual({ stage: "closed" })
      expect(desktopEvents).toContainEqual(
        expect.objectContaining({
          threadId: anotherThreadId,
          runId: queuedRunId,
          type: "run.interrupted",
        }),
      )
      expect(await call("run.list")).toMatchObject({
        runs: [{ runId: running.receipt!.runId, status: "running" }],
      })
      expect(await call("run.interrupt", { threadId, runId: running.receipt!.runId })).toEqual({
        interrupted: true,
      })
      expect(delivered).not.toContain(queuedText)
    } finally {
      releaseFirst()
      releaseAnother()
      phone.stdin.end()
      phone.kill()
      await host.stop()
      await rm(temp, { force: true, recursive: true })
    }
  },
  45_000,
)
