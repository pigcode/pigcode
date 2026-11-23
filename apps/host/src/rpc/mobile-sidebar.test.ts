import { spawn } from "node:child_process"
import { createInterface } from "node:readline"
import { fileURLToPath } from "node:url"
import { mobilePairingViewSchema, mobileThreadSummarySchema, rpcSuccessSchema } from "@pigcode/contracts"
import { Context } from "cordis"
import { expect, it } from "vitest"
import { apply as agents } from "../agents/registry"
import { FAKE_ASK_TEXT } from "../agents/fake"
import { MobileSidebarRpc } from "../mobile/sidebar-rpc"
import { PairedDevices } from "../mobile/paired-devices"
import { apply as projects } from "../services/projects"
import { apply as sessions } from "../services/sessions"
import { apply as settings } from "../services/settings"
import { apply as storage } from "../services/storage"
import { apply as threads } from "../services/threads"
import { MemoryTransport } from "./memory-transport"
import { PageTransport } from "./page-transport"
import { startMobileHost } from "./mobile-test-fixture"
import { RpcServer } from "./server"
import { ThreadFeed } from "./thread-feed"

it("publishes only mobile summaries and keeps each sidebar subscription independent", async () => {
  const ctx = new Context()
  await ctx.plugin(storage, { path: ":memory:" })
  await ctx.plugin(settings, {})
  await ctx.plugin(projects)
  await ctx.plugin(threads)
  await ctx.plugin(sessions)
  await ctx.plugin(agents)
  const visible = ctx.projects.add("/private/visible", "工作区")
  const deleted = ctx.projects.add("/private/hidden", "已移除")
  const parent = ctx.threads.create(visible.id, "原名称", "fake")
  const child = ctx.threads.create(visible.id, "子代理运行", "fake", parent.id)
  const hidden = ctx.threads.create(deleted.id, "不在侧栏", "fake")
  ctx.projects.remove(deleted.id)

  const devices = new PairedDevices(ctx.settings)
  const deviceKey = Buffer.alloc(32, 2).toString("base64url")
  devices.save({ publicKey: deviceKey, name: "测试手机", platform: "ios", lastConnectedAt: null })
  const feed = new ThreadFeed(ctx)
  const desktop = new MemoryTransport({ skip: ["thread.changed", "project.changed"] })
  const page = new PageTransport()
  page.attach(desktop.host)
  const desktopRpc = new RpcServer(ctx, page, feed)
  desktopRpc.start()
  const notifications: string[] = []
  desktop.client.onMessage((message) => {
    const method = (message as { method?: string }).method
    if (method) notifications.push(method)
  })
  let request = 0

  function phone(writable = false) {
    const transport = new MemoryTransport({ skip: ["sidebar.changed"] })
    const rpc = new MobileSidebarRpc(ctx, feed, transport.host, devices, {
      computerKey: Buffer.alloc(32, 1),
      computerName: "测试电脑",
      deviceKey,
      features: writable ? ["sidebar.read", "sidebar.write", "connection.status"] : ["sidebar.read", "connection.status"],
      relayRevision: () => undefined,
    })
    const changes: unknown[] = []
    transport.client.onMessage((value) => {
      if ((value as { method?: string }).method === "sidebar.changed") changes.push(value)
    })
    rpc.start()
    return { wire: transport, rpc, changes }
  }
  async function call(wire: MemoryTransport, method: string, params = {}) {
    const id = String(++request)
    wire.client.send({ jsonrpc: "2.0", id, method, params })
    const response = await wire.client.next()
    expect(response).toMatchObject({ id, jsonrpc: "2.0" })
    return response
  }

  const first = phone()
  const second = phone(true)
  try {
    expect(await call(first.wire, "project.list")).toMatchObject({
      result: [{ id: visible.id, name: "工作区" }],
    })
    const projectsReply = (await call(first.wire, "project.list")) as { result: unknown[] }
    expect(projectsReply.result).toEqual([{ id: visible.id, name: "工作区" }])
    const threadReply = (await call(first.wire, "thread.list")) as { result: unknown[] }
    expect(threadReply.result).toEqual([
      {
        id: parent.id,
        projectId: visible.id,
        title: "原名称",
        updatedAt: parent.updatedAt,
        archived: false,
        pinned: false,
        status: "idle",
        unread: false,
      },
    ])
    expect(await call(first.wire, "thread.list", { projectId: deleted.id })).toMatchObject({
      error: { code: "RESOURCE_NOT_AVAILABLE" },
    })
    expect(await call(first.wire, "project.list", { rootPath: "/private" })).toMatchObject({
      error: { code: "INVALID_PARAMS" },
    })
    for (const method of ["thread.rename", "terminal.open", "unknown.method"]) {
      expect(await call(first.wire, method)).toMatchObject({
        error: { code: "METHOD_NOT_AVAILABLE" },
      })
    }

    const oversized = ctx.threads.create(visible.id, "长".repeat(25_000), "fake")
    const paged = (await call(first.wire, "thread.list")) as {
      result: Array<{ id: string; title: string }>
    }
    expect(paged.result).toHaveLength(2)
    expect(paged.result.find((row) => row.id === oversized.id)?.title).toMatch(/…$/)
    expect(paged.result.find((row) => row.id === oversized.id)?.title.length).toBeLessThanOrEqual(
      512,
    )

    await call(first.wire, "sidebar.subscribe")
    await call(second.wire, "sidebar.subscribe")
    const pin = { threadId: parent.id, pinned: true }
    expect(await call(first.wire, "thread.setPinned", pin)).toMatchObject({
      error: { code: "METHOD_NOT_AVAILABLE" },
    })
    expect(await call(second.wire, "thread.setPinned", { ...pin, projectId: visible.id })).toMatchObject({
      error: { code: "INVALID_PARAMS" },
    })
    for (const threadId of [child.id, hidden.id]) {
      expect(await call(second.wire, "thread.setPinned", { threadId, pinned: true })).toMatchObject({
        error: { code: "RESOURCE_NOT_AVAILABLE" },
      })
    }
    expect(await call(second.wire, "thread.setPinned", pin)).toMatchObject({ result: {} })
    expect(await call(desktop, "thread.list")).toMatchObject({
      result: expect.arrayContaining([expect.objectContaining({ id: parent.id, pinned: true })]),
    })
    await call(desktop, "project.rename", { projectId: visible.id, name: "新项目名" })
    await call(desktop, "thread.rename", { threadId: parent.id, title: "新标题" })
    await expect
      .poll(() => notifications)
      .toEqual(expect.arrayContaining(["project.changed", "thread.changed"]))
    await expect.poll(() => first.changes.length).toBeGreaterThan(0)
    await expect.poll(() => second.changes.length).toBeGreaterThan(0)

    const refreshed = new MemoryTransport({ skip: ["thread.changed", "project.changed"] })
    const priorMobile = second.changes.length
    desktopRpc.releasePage()
    page.attach(refreshed.host)
    await call(refreshed, "project.rename", { projectId: visible.id, name: "窗口刷新后" })
    await expect.poll(() => second.changes.length).toBeGreaterThan(priorMobile)
    expect(await call(first.wire, "project.list")).toMatchObject({
      result: [{ id: visible.id, name: "窗口刷新后" }],
    })

    first.rpc.stop()
    const priorFirst = first.changes.length
    const priorSecond = second.changes.length
    await call(refreshed, "thread.archive", { threadId: parent.id })
    await expect.poll(() => second.changes.length).toBeGreaterThan(priorSecond)
    expect(first.changes).toHaveLength(priorFirst)
    expect(await call(second.wire, "thread.list")).toMatchObject({
      result: expect.arrayContaining([
        expect.objectContaining({ id: parent.id, title: "新标题", archived: true, pinned: false }),
      ]),
    })
    expect(await call(second.wire, "thread.unarchive", { threadId: parent.id })).toMatchObject({ result: {} })
    devices.remove(devices.find(deviceKey)!)
    expect(await call(second.wire, "thread.setPinned", pin)).toMatchObject({
      error: { code: "DEVICE_REVOKED" },
    })
  } finally {
    first.rpc.stop()
    second.rpc.stop()
    desktopRpc.stop()
    await ctx.fiber.dispose()
  }
})

const address = process.env.PIGCODE_RELAY_TEST_URL
const token = process.env.PIGCODE_RELAY_TEST_TOKEN

it.skipIf(!address || !token)(
  "keeps two Dart sidebars current with the desktop Host across a real Go relay",
  async () => {
    const host = await startMobileHost()
    const dart = spawn("dart", ["run", "scripts/verify-device-management.dart"], {
      cwd: fileURLToPath(new URL("../../../mobile", import.meta.url)),
      env: process.env,
      stdio: ["pipe", "pipe", "pipe"],
    })
    let diagnostics = ""
    dart.stderr.setEncoding("utf8").on("data", (chunk: string) => (diagnostics += chunk))
    dart.on("error", (error) => (diagnostics += error.message))
    const lines = createInterface({ input: dart.stdout })[Symbol.asyncIterator]()
    async function call(method: string, params?: Record<string, unknown>) {
      return rpcSuccessSchema.parse(await host.call(method, params)).result
    }
    function send(phone: string, action: string, extras: Record<string, unknown> = {}) {
      dart.stdin.write(JSON.stringify({ phone, action, ...extras }) + "\n")
    }
    async function receive() {
      const entry = await lines.next()
      if (entry.done) throw new Error(diagnostics || "Dart verification exited early")
      return JSON.parse(entry.value) as {
        stage: string
        code?: string
        projects?: unknown[]
        threads?: unknown[]
      }
    }
    async function pair(phone: string) {
      const started = mobilePairingViewSchema.parse(await call("mobile.pairing.start"))
      const attempt = started.attempt
      if (!attempt?.qr) throw new Error("desktop did not produce a pairing QR")
      send(phone, "pair", { qr: attempt.qr })
      const proof = await receive()
      expect(proof.stage).toBe("code")
      const pending = mobilePairingViewSchema.parse(await call("mobile.pairing")).attempt?.candidate
      expect(pending).toMatchObject({ name: phone, code: proof.code })
      await call("mobile.pairing.confirm", { id: attempt.id, confirmation: pending?.confirmation })
      expect(await receive()).toEqual({ stage: "ready" })
      send(phone, "save")
      expect(await receive()).toEqual({ stage: "saved" })
    }
    const first = "个人 iPhone"
    const second = "工作 Android"

    try {
      await call("relay.testAndSave", { address, token })
      const main = (await call("project.add", {
        rootPath: "/tmp/pigcode-sidebar-main",
        name: "桌面工作台",
      })) as { id: string }
      const docs = (await call("project.add", {
        rootPath: "/tmp/pigcode-sidebar-docs",
        name: "文档",
      })) as { id: string }
      for (let index = 0; index < 65; index++) {
        await call("thread.create", { projectId: main.id, title: "会话 " + index, agentId: "fake" })
      }
      const target = (await call("thread.create", {
        projectId: docs.id,
        title: "快速验收",
        agentId: "fake",
      })) as { id: string }

      for (const phone of [first, second]) {
        await pair(phone)
        send(phone, "sidebar")
        const snapshot = await receive()
        expect(snapshot.stage).toBe("sidebar")
        expect(snapshot.projects).toEqual([
          { id: main.id, name: "桌面工作台" },
          { id: docs.id, name: "文档" },
        ])
        expect(snapshot.threads).toHaveLength(66)
      }

      await call("project.rename", { projectId: docs.id, name: "已同步文档" })
      send(first, "sidebarPin", { threadId: target.id, pinned: true })
      expect(await receive()).toEqual({ stage: "sidebarEdited" })
      await call("run.start", { threadId: target.id, text: "验证会话摘要" })
      let firstReadTarget: ReturnType<typeof mobileThreadSummarySchema.parse>["readTarget"]
      for (const phone of [first, second]) {
        send(phone, "sidebar", {
          projectName: "已同步文档",
          threadId: target.id,
          status: "completed",
        })
        const snapshot = await receive()
        expect(snapshot).toMatchObject({
          stage: "sidebar",
          projects: expect.arrayContaining([{ id: docs.id, name: "已同步文档" }]),
          threads: expect.arrayContaining([
            expect.objectContaining({ id: target.id, pinned: true, status: "completed", unread: true }),
          ]),
        })
        if (phone === first) {
          firstReadTarget = snapshot.threads?.map((row) => mobileThreadSummarySchema.parse(row))
            .find((thread) => thread.id === target.id)?.readTarget
        }
      }
      expect(firstReadTarget).toMatchObject({ runId: expect.any(String), revision: 0 })
      send(first, "sidebarAcknowledgeRead", { threadId: target.id, target: firstReadTarget })
      expect(await receive()).toEqual({ stage: "sidebarEdited" })
      expect(await call("thread.list", { projectId: docs.id })).toMatchObject([
        { id: target.id, unread: false, pinned: true },
      ])
      send(second, "sidebarRead", { threadId: target.id, read: false })
      expect(await receive()).toEqual({ stage: "sidebarEdited" })
      send(first, "sidebarAcknowledgeRead", { threadId: target.id, target: firstReadTarget })
      expect(await receive()).toEqual({ stage: "sidebarEdited" })
      expect(await call("thread.list", { projectId: docs.id })).toMatchObject([
        { id: target.id, unread: true, readTarget: { revision: 1 } },
      ])

      send(first, "disconnect")
      expect(await receive()).toEqual({ stage: "closed" })
      const called = host.ctx.threads.create(docs.id, "等你处理", "fake")
      const pending = await host.ctx.agents.startRun(called.id, FAKE_ASK_TEXT)
      send(second, "sidebarMarkAllRead")
      expect(await receive()).toEqual({ stage: "sidebarEdited" })
      await call("project.rename", { projectId: docs.id, name: "另一端仍在线" })
      send(second, "sidebar", { projectName: "另一端仍在线", threadId: called.id, status: "waiting-approval" })
      expect(await receive()).toMatchObject({
        stage: "sidebar",
        threads: expect.arrayContaining([
          expect.objectContaining({ id: target.id, unread: false }),
          expect.objectContaining({ id: called.id, status: "waiting-approval" }),
        ]),
      })
      host.ctx.agents.cancelRun(pending.runId)
      await pending.done
      send(second, "sidebarArchive", { threadId: target.id, archived: true })
      expect(await receive()).toEqual({ stage: "sidebarEdited" })
      expect(await call("thread.list", { projectId: docs.id })).toEqual(expect.arrayContaining([
        expect.objectContaining({ id: target.id, pinned: false, archivedAt: expect.any(String) }),
      ]))
    } finally {
      dart.stdin.end()
      dart.kill()
      await host.stop()
    }
  },
  45_000,
)
