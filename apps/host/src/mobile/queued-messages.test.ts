import { spawn } from "node:child_process"
import { randomUUID } from "node:crypto"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createInterface } from "node:readline"
import { fileURLToPath } from "node:url"
import {
  mobilePairingViewSchema,
  queuedMessagesSnapshot,
  rpcSuccessSchema,
} from "@pigcode/contracts"
import { expect, it } from "vitest"
import { FakeAgentDriver } from "../agents/fake"
import { MemoryTransport } from "../rpc/memory-transport"
import { startMobileHost } from "../rpc/mobile-test-fixture"
import { ThreadFeed } from "../rpc/thread-feed"
import { PairedDevices } from "./paired-devices"
import { MobileSidebarRpc } from "./sidebar-rpc"

it("shares one FIFO across desktop and mobile and preserves the first receipt", async () => {
  const wire = new MemoryTransport()
  const deviceKey = Buffer.alloc(32, 9).toString("base64url")
  const sent: string[] = []
  let finish!: () => void
  const first = new Promise<void>((resolve) => (finish = resolve))
  let releaseCleanup!: () => void
  const nativeCleanup = new Promise<void>((resolve) => (releaseCleanup = resolve))
  class ControlledAgent extends FakeAgentDriver {
    override async send(
      session: Parameters<FakeAgentDriver["send"]>[0],
      input: Parameters<FakeAgentDriver["send"]>[1],
      runtime: Parameters<FakeAgentDriver["send"]>[2],
    ) {
      sent.push(input.text)
      if (input.text === "第一条") await first
      if (input.text === "等待清理") {
        if (!runtime.signal.aborted) {
          await new Promise<void>((resolve) =>
            runtime.signal.addEventListener("abort", () => resolve(), { once: true }),
          )
        }
        await nativeCleanup
        return
      }
      await super.send(session, input, runtime)
    }
  }
  let threadId = ""
  let mobile!: MobileSidebarRpc
  const host = await startMobileHost({
    prepare(ctx) {
      ctx.agents.register(new ControlledAgent())
      const projectId = ctx.projects.add("/tmp/pigcode-message-queue", "队列验收").id
      threadId = ctx.threads.create(projectId, "前后端同一会话", "fake").id
      const devices = new PairedDevices(ctx.settings)
      devices.save({ publicKey: deviceKey, name: "测试手机", platform: "ios", lastConnectedAt: 1 })
      mobile = new MobileSidebarRpc(ctx, new ThreadFeed(ctx), wire.host, devices, {
        computerKey: Buffer.alloc(32, 1),
        computerName: "测试电脑",
        deviceKey,
        features: ["queue.write", "run.write"],
        relayRevision: () => undefined,
      })
      mobile.start()
    },
  })
  async function phone(method: string, params: Record<string, unknown>) {
    const id = randomUUID()
    wire.client.send({ jsonrpc: "2.0", id, method, params })
    const reply = await wire.client.next()
    expect(reply).toMatchObject({ id })
    return reply
  }

  try {
    expect(await host.call("run.start", { threadId, text: "第一条" })).toMatchObject({
      result: { runId: expect.any(String) },
    })
    const second = { commandId: randomUUID(), threadId, text: "手机第二条" }
    const accepted = await phone("run.start", second)
    const { result: firstReceipt } = accepted as { result: { queuedMessageId: string } }
    expect(accepted).toMatchObject({
      result: { commandId: second.commandId, queuedMessageId: expect.any(String) },
    })
    expect(await phone("command.receipt", { commandId: second.commandId })).toMatchObject({
      result: { receipt: firstReceipt },
    })
    expect(await phone("run.start", second)).toMatchObject({ result: firstReceipt })
    const third = await host.call("run.start", { threadId, text: "桌面第三条" })
    expect(third).toMatchObject({ result: { queuedMessageId: expect.any(String) } })
    const pending = {
      result: { paused: false, messages: [{ text: second.text }, { text: "桌面第三条" }] },
    }
    expect(await phone("queue.get", { threadId })).toMatchObject(pending)
    expect(await host.call("queue.get", { threadId })).toMatchObject(pending)
    expect(sent).toEqual(["第一条"])
    finish()
    await expect.poll(() => sent).toEqual(["第一条", "手机第二条", "桌面第三条"])

    const previous = (await host.call("run.start", { threadId, text: "等待清理" })) as {
      result: { runId: string }
    }
    await expect.poll(() => sent).toContain("等待清理")
    await host.call("run.start", { threadId, text: "桌面队首" })
    const chosen = (await host.call("run.start", { threadId, text: "从手机指定的桌面消息" })) as {
      result: { queuedMessageId: string }
    }
    expect(
      await phone("queue.stopAndSend", {
        threadId,
        commandId: randomUUID(),
        runId: previous.result.runId,
        messageId: chosen.result.queuedMessageId,
      }),
    ).toMatchObject({ result: { effect: "scheduled" } })
    expect(sent).not.toContain("从手机指定的桌面消息")
    const view = (await host.call("mobile.pairing")) as {
      result: { devices: { id: string }[] }
    }
    expect(
      await host.call("mobile.devices.revoke", { deviceId: view.result.devices[0]!.id }),
    ).toMatchObject({
      result: { status: "revoked" },
    })
    releaseCleanup()
    expect(await host.call("queue.get", { threadId })).toMatchObject({
      result: { paused: true, messages: [{ text: "桌面队首" }, { text: "从手机指定的桌面消息" }] },
    })
    expect(sent).not.toContain("从手机指定的桌面消息")
    await host.call("queue.resume", { threadId, commandId: randomUUID() })
    await expect.poll(() => sent.slice(-2)).toEqual(["桌面队首", "从手机指定的桌面消息"])
  } finally {
    finish()
    releaseCleanup()
    mobile.stop()
    await host.stop()
  }
})

const address = process.env.PIGCODE_RELAY_TEST_URL
const token = process.env.PIGCODE_RELAY_TEST_TOKEN

it.skipIf(!address || !token)(
  "withdraws, stops the selected run, pauses on failure and restart, and revokes queued device input over Go WSS",
  async () => {
    const dir = await mkdtemp(join(tmpdir(), "pigcode-queued-messages-"))
    const paths = { settingsPath: join(dir, "settings.json"), storagePath: join(dir, "host.db") }
    const sent: string[] = []
    class ControlledAgent extends FakeAgentDriver {
      override async send(
        session: Parameters<FakeAgentDriver["send"]>[0],
        input: Parameters<FakeAgentDriver["send"]>[1],
        runtime: Parameters<FakeAgentDriver["send"]>[2],
      ) {
        sent.push(input.text)
        if (input.text.startsWith("等待")) {
          if (!runtime.signal.aborted) {
            await new Promise<void>((resolve) =>
              runtime.signal.addEventListener("abort", () => resolve(), { once: true }),
            )
          }
          return
        }
        if (input.text === "模拟失败") {
          runtime.emit({ type: "run.failed", message: "验收用失败" })
          return
        }
        await super.send(session, input, runtime)
      }
    }
    let threadId = ""
    let host = await startMobileHost({
      ...paths,
      prepare(ctx) {
        ctx.agents.register(new ControlledAgent())
        const projectId = ctx.projects.add(dir, "共享待发验收").id
        threadId = ctx.threads.create(projectId, "前后端共享队列", "fake").id
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
      if (entry.done) throw new Error(diagnostics || "Dart verification exited early")
      return JSON.parse(entry.value) as { stage: string; code?: string; receipt?: unknown }
    }
    async function phone(action: string, params?: Record<string, unknown>) {
      send(action, params)
      return receive()
    }
    async function desktop(method: string, params?: Record<string, unknown>) {
      return rpcSuccessSchema.parse(await host.call(method, params)).result
    }
    async function addText(text: string) {
      const accepted = await phone("startCommand", { commandId: randomUUID(), threadId, text })
      expect(accepted).toMatchObject({ receipt: { queuedMessageId: expect.any(String) } })
      return accepted.receipt as { queuedMessageId: string; runId: string }
    }
    async function snapshot() {
      return queuedMessagesSnapshot.parse(await desktop("queue.get", { threadId }))
    }
    async function pair() {
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
    }
    try {
      await desktop("relay.testAndSave", { address, token })
      await pair()
      const first = (await desktop("run.start", { threadId, text: "等待原 run" })) as {
        runId: string
      }
      const head = (await desktop("run.start", { threadId, text: "等待下一轮" })) as {
        runId: string
      }
      const withdrawn = await addText("撤回\n保留原文")
      const selected = await addText("模拟失败")
      await addText("这条将在撤销设备后取消")
      await desktop("run.start", { threadId, text: "桌面保留" })

      const withdraw = { commandId: randomUUID(), threadId, messageId: withdrawn.queuedMessageId }
      const receipt = await phone("queueAction", { method: "queue.withdraw", params: withdraw })
      expect(receipt).toMatchObject({ receipt: { effect: "withdrawn", text: "撤回\n保留原文" } })
      expect(await phone("queueAction", { method: "queue.withdraw", params: withdraw })).toEqual(
        receipt,
      )
      expect(
        await host.call("queue.withdraw", { ...withdraw, commandId: randomUUID() }),
      ).toMatchObject({
        error: { code: "QUEUE_MESSAGE_UNAVAILABLE" },
      })

      const choose = {
        commandId: randomUUID(),
        threadId,
        runId: first.runId,
        messageId: selected.queuedMessageId,
      }
      expect(
        await phone("queueAction", {
          method: "queue.stopAndSend",
          params: { ...choose, runId: "wrong-run" },
        }),
      ).toEqual({ stage: "failed", code: "QUEUE_STALE_RUN" })
      expect(sent).toEqual(["等待原 run"])
      const scheduled = await phone("queueAction", { method: "queue.stopAndSend", params: choose })
      expect(scheduled).toMatchObject({
        receipt: { effect: "scheduled", stoppedRunId: first.runId, runId: selected.runId },
      })
      await expect.poll(snapshot).toMatchObject({
        paused: true,
        messages: [
          { text: "等待下一轮" },
          { text: "这条将在撤销设备后取消" },
          { text: "桌面保留" },
        ],
      })
      expect(sent).toEqual(["等待原 run", "模拟失败"])
      await desktop("run.start", { threadId, text: "暂停时追加" })
      expect(sent).toEqual(["等待原 run", "模拟失败"])

      expect(await phone("disconnect")).toEqual({ stage: "closed" })
      await host.stop()
      host = await startMobileHost({
        ...paths,
        prepare: (ctx) => ctx.agents.register(new ControlledAgent()),
      })
      await expect.poll(() => phone("reconnect"), { timeout: 8000 }).toEqual({ stage: "ready" })
      expect(await phone("lookupQueue", { commandId: choose.commandId })).toEqual(scheduled)
      expect(await phone("queueSnapshot", { threadId })).toMatchObject({
        snapshot: { paused: true },
      })

      const resume = { threadId, commandId: randomUUID() }
      const continued = await phone("queueAction", { method: "queue.resume", params: resume })
      expect(continued).toMatchObject({ receipt: { effect: "resumed", runId: head.runId } })
      expect(await phone("queueAction", { method: "queue.resume", params: resume })).toEqual(
        continued,
      )
      await expect.poll(() => sent).toEqual(["等待原 run", "模拟失败", "等待下一轮"])
      const { devices } = mobilePairingViewSchema.parse(await desktop("mobile.pairing"))
      expect(await desktop("mobile.devices.revoke", { deviceId: devices[0]!.id })).toMatchObject({
        status: "revoked",
      })
      expect(await phone("closed")).toEqual({ stage: "closed" })
      expect(await snapshot()).toMatchObject({
        activeRunId: head.runId,
        messages: [{ text: "桌面保留" }, { text: "暂停时追加" }],
      })
      await desktop("run.interrupt", { threadId, runId: head.runId })
      expect(await snapshot()).toMatchObject({ paused: true })
      expect(await desktop("queue.resume", { commandId: randomUUID(), threadId })).toMatchObject({
        effect: "resumed",
      })
      await expect
        .poll(() => sent)
        .toEqual(["等待原 run", "模拟失败", "等待下一轮", "桌面保留", "暂停时追加"])
      await expect.poll(snapshot).toMatchObject({ paused: false, messages: [] })
    } finally {
      dart.stdin.end()
      dart.kill()
      await host.stop()
      await rm(dir, { force: true, recursive: true })
    }
  },
  45_000,
)
