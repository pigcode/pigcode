import { spawn } from "node:child_process"
import { randomUUID } from "node:crypto"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createInterface } from "node:readline"
import { fileURLToPath } from "node:url"
import { mobileDraftReceipt, mobilePairingViewSchema, rpcSuccessSchema } from "@pigcode/contracts"
import { expect, it } from "vitest"
import type { AgentDriver, CreateSessionInput } from "../agents/driver"
import { FakeAgentDriver } from "../agents/fake"
import { MemoryTransport } from "../rpc/memory-transport"
import { startMobileHost } from "../rpc/mobile-test-fixture"
import { ThreadFeed } from "../rpc/thread-feed"
import { PairedDevices } from "./paired-devices"
import { MobileSidebarRpc } from "./sidebar-rpc"

it("keeps a draft outside the sidebar and atomically accepts the first message once", async () => {
  const wire = new MemoryTransport()
  const deviceKey = Buffer.alloc(32, 7).toString("base64url")
  let projectId = ""
  let instanceId = ""
  let mobile!: MobileSidebarRpc
  let rejectReceipt!: (reject: boolean) => void
  const host = await startMobileHost({
    prepare(ctx) {
      projectId = ctx.projects.add("/tmp/pigcode-mobile-draft", "首发验收").id
      instanceId = ctx.agents.createInstance("fake", "首发验收实例").instanceId
      const disabled = ctx.agents.createInstance("fake", "已禁用")
      ctx.agents.updateInstance(disabled.instanceId, { enabled: false })
      ctx.agents.setDefaultAgent("fake", instanceId)
      rejectReceipt = (reject) =>
        ctx.storage.db.exec(
          reject
            ? `CREATE TRIGGER fail_draft_receipt BEFORE INSERT ON command_receipts
               BEGIN SELECT RAISE(ABORT, 'fixture receipt write failed'); END`
            : "DROP TRIGGER fail_draft_receipt",
        )
      const devices = new PairedDevices(ctx.settings)
      devices.save({ publicKey: deviceKey, name: "测试手机", platform: "ios", lastConnectedAt: 1 })
      mobile = new MobileSidebarRpc(ctx, new ThreadFeed(ctx), wire.host, devices, {
        computerKey: Buffer.alloc(32, 1),
        computerName: "测试电脑",
        deviceKey,
        features: ["draft.write", "sidebar.read"],
        relayRevision: () => undefined,
      })
      mobile.start()
    },
  })
  async function call(method: string, params: Record<string, unknown> = {}) {
    const id = randomUUID()
    wire.client.send({ jsonrpc: "2.0", id, method, params })
    const reply = await wire.client.next()
    expect(reply).toMatchObject({ id })
    return reply
  }

  try {
    const options = await call("thread.draftOptions")
    expect(options).toMatchObject({
      result: {
        defaultInstanceId: instanceId,
        instances: [{ instanceId: "fake" }, { instanceId, label: "首发验收实例" }],
      },
    })
    expect(await call("thread.draftModels", { instanceId })).toMatchObject({
      result: {
        defaultModelId: "fake-sage",
        models: [{ id: "fake-sage" }, { id: "fake-swift" }],
      },
    })
    expect(await call("thread.list", { projectId })).toMatchObject({ result: [] })
    const command = {
      commandId: randomUUID(),
      projectId,
      instanceId,
      modelId: "fake-swift",
      permissionMode: "approval-required",
      text: "手机发出的第一条消息",
    }
    expect(await call("thread.create", { ...command, modelId: "unknown" })).toMatchObject({
      error: { code: "DRAFT_SELECTION_UNAVAILABLE" },
    })
    rejectReceipt(true)
    try {
      expect(await call("thread.create", command)).toMatchObject({
        error: { code: "COMMAND_FAILED" },
      })
      expect(await call("thread.list", { projectId })).toMatchObject({ result: [] })
      expect(await call("command.receipt", { commandId: command.commandId })).toMatchObject({
        result: {},
      })
    } finally {
      rejectReceipt(false)
    }
    const accepted = await call("thread.create", command)
    expect(accepted).toMatchObject({
      result: {
        method: "thread.create",
        commandId: command.commandId,
        projectId,
        title: command.text,
        threadId: expect.any(String),
        runId: expect.any(String),
      },
    })
    const { result } = accepted as { result: { threadId: string; runId: string } }
    expect(await call("thread.create", command)).toMatchObject({ result })
    expect(await call("command.receipt", { commandId: command.commandId })).toMatchObject({
      result: { receipt: result },
    })
    expect(await call("thread.create", { ...command, text: "另一条内容" })).toMatchObject({
      error: { code: "COMMAND_ID_CONFLICT" },
    })
    expect(await call("thread.list", { projectId })).toMatchObject({
      result: [{ id: result.threadId, title: command.text }],
    })
  } finally {
    mobile.stop()
    await host.stop()
  }
})

const address = process.env.PIGCODE_RELAY_TEST_URL
const token = process.env.PIGCODE_RELAY_TEST_TOKEN

it.skipIf(!address || !token)(
  "creates the draft over Go WSS, recovers its lost receipt, and uses the same Agent for the next run",
  async () => {
    const folder = await mkdtemp(join(tmpdir(), "pigcode-mobile-draft-"))
    const paths = {
      settingsPath: join(folder, "settings.json"),
      storagePath: join(folder, "host.db"),
    }
    const sessions: CreateSessionInput[] = []
    const sent: string[] = []
    let allowLaunch!: () => void
    const gate = new Promise<void>((resolve) => (allowLaunch = resolve))
    const fixture = new FakeAgentDriver()
    const driver: AgentDriver = {
      id: "draft-fixture",
      displayName: "Draft fixture",
      requiresInstance: true,
      features: fixture.features,
      executionModes: { plan: false, permissions: ["approval-required", "auto-accept-edits"] },
      detect: () => fixture.detect(),
      listModels: () => fixture.listModels(),
      async createSession(input) {
        sessions.push(input)
        await gate
        return {
          id: input.sessionId ?? "mobile-draft-session",
          threadId: input.threadId,
          cwd: input.cwd,
          nativeSessionId: "mobile-draft-native",
          permissionMode: input.permissionMode ?? "",
          model: input.model ?? null,
        }
      },
      async send(_session, input, runtime) {
        sent.push(input.text)
        runtime.emit({ type: "message.completed", text: "收到：" + input.text })
        runtime.emit({ type: "run.completed" })
      },
      interrupt: async () => undefined,
      dispose: async () => undefined,
    }
    let projectId = ""
    let instanceId = ""
    const agentConfig = { dataDir: join(folder, "agents") }
    let host = await startMobileHost({
      ...paths,
      agentConfig,
      prepare(ctx) {
        ctx.agents.register(driver)
        projectId = ctx.projects.add(folder, "手机首发验收").id
        instanceId = ctx.agents.createInstance(driver.id, "非默认实例").instanceId
        ctx.agents.setDefaultAgent(driver.id, instanceId)
      },
    })
    const dart = spawn("dart", ["run", "scripts/verify-device-management.dart"], {
      cwd: fileURLToPath(new URL("../../../mobile", import.meta.url)),
      stdio: ["pipe", "pipe", "pipe"],
    })
    let diagnostics = ""
    dart.stderr.setEncoding("utf8").on("data", (chunk: string) => (diagnostics += chunk))
    dart.on("error", (error) => (diagnostics += error.message))
    const lines = createInterface({ input: dart.stdout })[Symbol.asyncIterator]()
    function send(action: string, params: Record<string, unknown> = {}) {
      dart.stdin.write(JSON.stringify({ phone: "个人 iPhone", action, ...params }) + "\n")
    }
    async function receive() {
      const entry = await lines.next()
      if (entry.done) throw new Error(diagnostics || "Dart client exited early")
      return JSON.parse(entry.value) as { stage: string; code?: string; receipt?: unknown }
    }
    async function phone(action: string, params?: Record<string, unknown>) {
      send(action, params)
      return receive()
    }
    async function desktop(method: string, params?: Record<string, unknown>) {
      return rpcSuccessSchema.parse(await host.call(method, params)).result
    }
    try {
      await desktop("relay.testAndSave", { address, token })
      const { attempt } = mobilePairingViewSchema.parse(await desktop("mobile.pairing.start"))
      if (!attempt?.qr) throw new Error("missing pairing QR")
      send("pair", { qr: attempt.qr })
      const proof = await receive()
      const candidate = mobilePairingViewSchema.parse(await desktop("mobile.pairing")).attempt
        ?.candidate
      expect(candidate?.code).toBe(proof.code)
      await desktop("mobile.pairing.confirm", {
        id: attempt.id,
        confirmation: candidate?.confirmation,
      })
      expect(await receive()).toEqual({ stage: "ready" })
      expect(await phone("save")).toEqual({ stage: "saved" })
      expect(await phone("draftOptions")).toMatchObject({
        options: { defaultInstanceId: instanceId },
      })
      expect(await phone("draftModels", { instanceId })).toMatchObject({
        models: {
          defaultModelId: "fake-sage",
          models: [{ id: "fake-sage" }, { id: "fake-swift" }],
        },
      })
      expect(await phone("sidebar")).toMatchObject({ threads: [] })

      const first = {
        commandId: randomUUID(),
        projectId,
        instanceId,
        modelId: "fake-swift",
        permissionMode: "auto-accept-edits",
        text: "手机创建会话",
      }
      expect(await phone("createDraftWithoutReply", { params: first })).toEqual({
        stage: "waiting",
      })
      expect(await phone("createDraftWithoutReply", { params: first })).toEqual({
        stage: "waiting",
      })
      await expect
        .poll(() => phone("sidebar"), { timeout: 8000 })
        .toMatchObject({
          threads: [{ title: first.text }],
        })
      expect(sent).toEqual([])
      expect(await phone("disconnect")).toEqual({ stage: "closed" })
      allowLaunch()
      expect(await phone("reconnect")).toEqual({ stage: "ready" })
      const accepted = await phone("lookupDraft", { commandId: first.commandId })
      const receipt = mobileDraftReceipt.parse(accepted.receipt)
      expect(receipt).toMatchObject({ title: first.text, projectId })
      expect(await phone("createDraft", { params: first })).toEqual(accepted)
      expect(
        await phone("timeline", { threadId: receipt.threadId, answer: "收到：" + first.text }),
      ).toMatchObject({
        hasAnswer: true,
      })
      expect(sent).toEqual([first.text])

      const text = "接着发送"
      expect(
        await phone("startCommand", { commandId: randomUUID(), threadId: receipt.threadId, text }),
      ).toMatchObject({
        receipt: { threadId: receipt.threadId, runId: expect.any(String) },
      })
      expect(
        await phone("timeline", { threadId: receipt.threadId, answer: "收到：" + text }),
      ).toMatchObject({
        hasAnswer: true,
      })
      const selected = {
        threadId: receipt.threadId,
        instance: { instanceId },
        model: "fake-swift",
        permissionMode: "auto-accept-edits",
      }
      expect(sessions).toMatchObject([selected, selected])
      expect(await phone("sidebar")).toMatchObject({ threads: [{ id: receipt.threadId }] })

      expect(await phone("disconnect")).toEqual({ stage: "closed" })
      await host.stop()
      host = await startMobileHost(paths)
      await expect.poll(() => phone("reconnect"), { timeout: 8000 }).toEqual({ stage: "ready" })
      expect(await phone("lookupDraft", { commandId: first.commandId })).toEqual(accepted)
    } finally {
      allowLaunch()
      dart.stdin.end()
      dart.kill()
      await host.stop()
      await rm(folder, { force: true, recursive: true })
    }
  },
  45_000,
)
