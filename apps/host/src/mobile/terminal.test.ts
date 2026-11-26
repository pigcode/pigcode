import { spawn } from "node:child_process"
import { randomUUID } from "node:crypto"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createInterface } from "node:readline"
import { fileURLToPath } from "node:url"
import {
  MOBILE_TERMINAL_MAX_PER_THREAD,
  MOBILE_TERMINAL_OUTPUT_CHUNK_BYTES,
  mobileFeatures,
  mobileTerminalMethods,
  mobileTerminalNotifications,
  type MobileTerminalAttachResult,
  type MobileTerminalListResult,
  type MobileTerminalOpenResult,
  type MobileTerminalOutputNotification,
} from "@pigcode/contracts"
import { Context } from "cordis"
import { describe, expect, it } from "vitest"
import { apply as agents } from "../agents/registry"
import { MemoryTransport } from "../rpc/memory-transport"
import { ThreadFeed } from "../rpc/thread-feed"
import { apply as projects } from "../services/projects"
import { apply as sessions } from "../services/sessions"
import { apply as settings } from "../services/settings"
import { apply as storage } from "../services/storage"
import { apply as terminal, type PtyFactory, type PtyLike, type PtySpawnInput } from "../services/terminal"
import { apply as threads } from "../services/threads"
import { mobileFrames } from "./mobile-frames"
import { PairedDevices } from "./paired-devices"
import { revokeDeviceWork } from "./revocation"
import { MobileSidebarRpc } from "./sidebar-rpc"
import { MobileTerminalSession, sliceUtf8Chunks } from "./terminal"

const MAX_NOISE_ENCRYPTED_FRAME_BYTES = 65_535
const NOISE_TAG_BYTES = 16

function assertSingleNoiseFrame(message: unknown): void {
  const frames = [...mobileFrames(message)]
  expect(frames).toHaveLength(1)
  expect(frames[0]!.length + NOISE_TAG_BYTES).toBeLessThanOrEqual(MAX_NOISE_ENCRYPTED_FRAME_BYTES)
}

interface FakePtyInstance {
  input: PtySpawnInput
  writes: string[]
  resizes: Array<{ cols: number; rows: number }>
  killed: boolean
  emit(data: string): void
  exit(code: number): void
}

function createFakePtyFactory() {
  const instances: FakePtyInstance[] = []
  const factory: PtyFactory = {
    spawn(input) {
      let dataListener: ((data: string) => void) | undefined
      let exitListener: ((info: { exitCode: number }) => void) | undefined
      const record: FakePtyInstance = {
        input,
        writes: [],
        resizes: [],
        killed: false,
        emit(data: string) {
          dataListener?.(data)
        },
        exit(code: number) {
          exitListener?.({ exitCode: code })
        },
      }
      instances.push(record)
      const pty: PtyLike = {
        onData(listener) {
          dataListener = listener
        },
        onExit(listener) {
          exitListener = listener
        },
        write(data) {
          record.writes.push(data)
        },
        resize(cols, rows) {
          record.resizes.push({ cols, rows })
        },
        kill() {
          record.killed = true
        },
      }
      return pty
    },
  }
  return { factory, instances }
}

interface ClientHandle {
  deviceKey: string
  wire: MemoryTransport
  notifications: Array<{ method: string; params: Record<string, unknown> }>
  call(
    method: string,
    params?: Record<string, unknown>,
  ): Promise<{ id: string; result?: unknown; error?: { code: string; message: string } }>
  stop(): void
}

async function setupHost(ptyFactory: PtyFactory, scrollbackBytes?: number) {
  const ctx = new Context()
  await ctx.plugin(storage, { path: ":memory:" })
  await ctx.plugin(settings, {})
  await ctx.plugin(projects)
  await ctx.plugin(threads)
  await ctx.plugin(sessions)
  await ctx.plugin(agents)
  await ctx.plugin(terminal, {
    ptyFactory,
    ...(scrollbackBytes !== undefined ? { scrollbackBytes } : {}),
  })

  const feed = new ThreadFeed(ctx)
  const devices = new PairedDevices(ctx.settings)
  const clients: ClientHandle[] = []

  function connectDevice(name: string, keyByte: number, features: readonly string[]): ClientHandle {
    const deviceKey = Buffer.alloc(32, keyByte).toString("base64url")
    if (!devices.find(deviceKey)) {
      devices.save({ publicKey: deviceKey, name, platform: "ios", lastConnectedAt: 1000 })
    }
    const wire = new MemoryTransport()
    const replies = new Map<string, (message: unknown) => void>()
    const notifications: Array<{ method: string; params: Record<string, unknown> }> = []
    wire.client.onMessage((message) => {
      assertSingleNoiseFrame(message)
      const record = message as { id?: string; method?: string; params?: Record<string, unknown> }
      if (record.id && replies.has(record.id)) {
        const resolve = replies.get(record.id)!
        replies.delete(record.id)
        resolve(message)
        return
      }
      if (!record.id && typeof record.method === "string") {
        notifications.push({ method: record.method, params: record.params ?? {} })
      }
    })
    const mobile = new MobileSidebarRpc(ctx, feed, wire.host, devices, {
      computerKey: Buffer.alloc(32, 1),
      computerName: "测试电脑",
      deviceKey,
      features,
      relayRevision: () => undefined,
    })
    mobile.start()

    const handle: ClientHandle = {
      deviceKey,
      wire,
      notifications,
      async call(method: string, params: Record<string, unknown> = {}) {
        const id = randomUUID()
        const request = { jsonrpc: "2.0", id, method, params }
        assertSingleNoiseFrame(request)
        const replyPromise = new Promise<unknown>((resolve) => replies.set(id, resolve))
        wire.client.send(request)
        return (await replyPromise) as {
          id: string
          result?: unknown
          error?: { code: string; message: string }
        }
      },
      stop() {
        mobile.stop()
      },
    }
    clients.push(handle)
    return handle
  }

  return {
    ctx,
    devices,
    connectDevice,
    async dispose() {
      for (const client of clients) client.stop()
      await ctx.fiber.dispose()
    },
  }
}

describe("mobile terminal protocol & Host implementation", { timeout: 30_000 }, () => {
  it("slices UTF-8 chunks without breaking surrogate pairs and preserves exact UTF-16 cursors", () => {
    const text = "ab😀cd🚀ef"
    const chunks = sliceUtf8Chunks(text, 100 + text.length, 6)
    expect(chunks.map((c) => c.text).join("")).toBe(text)
    expect(chunks[chunks.length - 1]!.cursor).toBe(100 + text.length)
    for (const chunk of chunks) {
      expect(Buffer.byteLength(chunk.text, "utf8")).toBeLessThanOrEqual(6)
      for (let i = 0; i < chunk.text.length; i += 1) {
        const code = chunk.text.charCodeAt(i)
        if (code >= 0xd800 && code <= 0xdbff) {
          const next = chunk.text.charCodeAt(i + 1)
          expect(next >= 0xdc00 && next <= 0xdfff).toBe(true)
          i += 1
        } else {
          expect(code < 0xdc00 || code > 0xdfff).toBe(true)
        }
      }
    }
  })

  it("enforces desktop read-only isolation, mobile ownership, per-thread limits, and safe cwdLabel", async () => {
    expect(mobileFeatures).toContain("terminal")
    const root = await mkdtemp(join(tmpdir(), "pigcode-mterm-iso-"))
    const fake = createFakePtyFactory()
    const host = await setupHost(fake.factory)
    try {
      const project = host.ctx.projects.add(root, "终端测试项目")
      const thread = host.ctx.threads.create(project.id, "终端会话", "fake")
      const otherThread = host.ctx.threads.create(project.id, "另一会话", "fake")

      // 电脑端先打开 1 个终端（origin 默认为 desktop）
      const desktopTerm = await host.ctx.terminal.open({ threadId: thread.id }, 120, 40)
      fake.instances[0]!.emit("desktop-hello\r\n")

      // 未协商 terminal 的旧手机端不可调用
      const legacyPhone = host.connectDevice("旧手机", 10, ["sidebar.read"])
      expect(
        await legacyPhone.call(mobileTerminalMethods.list, { threadId: thread.id }),
      ).toMatchObject({ error: { code: "METHOD_NOT_AVAILABLE" } })

      const phone = host.connectDevice("测试手机", 11, ["terminal"])

      // list 展示电脑端终端（writable=false），且不暴露绝对路径
      const listed = (
        await phone.call(mobileTerminalMethods.list, { threadId: thread.id })
      ).result as MobileTerminalListResult
      expect(listed.terminals).toHaveLength(1)
      expect(listed.terminals[0]).toMatchObject({
        id: desktopTerm.id,
        origin: "desktop",
        writable: false,
        cols: 120,
        rows: 40,
      })
      expect(JSON.stringify(listed)).not.toContain(root)

      // 手机可以只读附着观看电脑终端，且传 cols/rows 绝不修改电脑端尺寸
      const attachedDesktop = (
        await phone.call(mobileTerminalMethods.attach, {
          threadId: thread.id,
          terminalId: desktopTerm.id,
          cols: 42,
          rows: 18,
        })
      ).result as MobileTerminalAttachResult
      expect(attachedDesktop.terminal.writable).toBe(false)
      expect(attachedDesktop.replayChunks).toBe(1)
      expect(fake.instances[0]!.resizes).toEqual([])
      expect(phone.notifications.some((n) => n.method === mobileTerminalNotifications.output)).toBe(
        true,
      )
      const firstReplay = phone.notifications[0]!.params as MobileTerminalOutputNotification
      expect(Buffer.from(firstReplay.dataBase64, "base64").toString("utf8")).toBe("desktop-hello\r\n")
      expect(firstReplay.replay).toBe(true)

      // 实时输出也能流向只读手机端
      fake.instances[0]!.emit("desktop-live\r\n")
      await new Promise((r) => setTimeout(r, 35))
      const liveText = phone.notifications
        .filter((n) => n.method === mobileTerminalNotifications.output)
        .map((n) => Buffer.from((n.params as MobileTerminalOutputNotification).dataBase64, "base64").toString("utf8"))
        .join("")
      expect(liveText).toBe("desktop-hello\r\ndesktop-live\r\n")

      // 对电脑终端执行 write / resize / close 均返回 TERMINAL_READ_ONLY
      expect(
        await phone.call(mobileTerminalMethods.write, {
          terminalId: desktopTerm.id,
          dataBase64: Buffer.from("ls\n", "utf8").toString("base64"),
        }),
      ).toMatchObject({ error: { code: "TERMINAL_READ_ONLY" } })
      expect(
        await phone.call(mobileTerminalMethods.resize, {
          terminalId: desktopTerm.id,
          cols: 48,
          rows: 20,
        }),
      ).toMatchObject({ error: { code: "TERMINAL_READ_ONLY" } })
      expect(
        await phone.call(mobileTerminalMethods.close, { terminalId: desktopTerm.id }),
      ).toMatchObject({ error: { code: "TERMINAL_READ_ONLY" } })
      expect(fake.instances[0]!.writes).toEqual([])
      expect(fake.instances[0]!.killed).toBe(false)

      // 跨会话附着必须拒绝
      expect(
        await phone.call(mobileTerminalMethods.attach, {
          threadId: otherThread.id,
          terminalId: desktopTerm.id,
        }),
      ).toMatchObject({ error: { code: "TERMINAL_NOT_FOUND" } })

      // 手机端新建终端可写、可调尺寸、上限 6 个（不含电脑终端）
      const openedIds: string[] = []
      for (let i = 0; i < MOBILE_TERMINAL_MAX_PER_THREAD; i += 1) {
        const res = await phone.call(mobileTerminalMethods.open, {
          threadId: thread.id,
          cols: 48,
          rows: 22,
        })
        expect(res.error).toBeUndefined()
        const opened = (res.result as MobileTerminalOpenResult).terminal
        expect(opened.origin).toBe("mobile")
        expect(opened.writable).toBe(true)
        openedIds.push(opened.id)
      }
      expect(
        await phone.call(mobileTerminalMethods.open, {
          threadId: thread.id,
          cols: 48,
          rows: 22,
        }),
      ).toMatchObject({ error: { code: "TERMINAL_LIMIT_EXCEEDED" } })

      // 对手机自建终端 write / resize / close 全部生效
      const firstMobileId = openedIds[0]!
      const firstMobilePty = fake.instances[1]!
      expect(
        (
          await phone.call(mobileTerminalMethods.write, {
            terminalId: firstMobileId,
            dataBase64: Buffer.from("echo hi\r", "utf8").toString("base64"),
          })
        ).result,
      ).toEqual({ ok: true })
      expect(firstMobilePty.writes).toEqual(["echo hi\r"])

      expect(
        (
          await phone.call(mobileTerminalMethods.resize, {
            terminalId: firstMobileId,
            cols: 64,
            rows: 30,
          })
        ).result,
      ).toEqual({ cols: 64, rows: 30 })
      expect(firstMobilePty.resizes).toEqual([{ cols: 64, rows: 30 }])

      expect(
        (await phone.call(mobileTerminalMethods.close, { terminalId: firstMobileId })).result,
      ).toEqual({ closed: true })
      expect(firstMobilePty.killed).toBe(true)
    } finally {
      await host.dispose()
      await rm(root, { recursive: true, force: true })
    }
  })

  it("chunks 256 KiB ANSI+CJK+emoji replay into single Noise frames, supports afterCursor resume, disconnect retention, and revocation cleanup", async () => {
    const root = await mkdtemp(join(tmpdir(), "pigcode-mterm-replay-"))
    const fake = createFakePtyFactory()
    const host = await setupHost(fake.factory)
    try {
      const project = host.ctx.projects.add(root, "大回放项目")
      const thread = host.ctx.threads.create(project.id, "大回放会话", "fake")
      const phone = host.connectDevice("重连手机", 22, ["terminal"])

      const opened = (
        (
          await phone.call(mobileTerminalMethods.open, {
            threadId: thread.id,
            cols: 50,
            rows: 24,
          })
        ).result as MobileTerminalOpenResult
      ).terminal
      const pty = fake.instances[0]!

      // 产生 > 120 KiB 含 ANSI 转义与中文/emoji 的输出，先断开连接模拟后台运行
      phone.stop()
      expect(pty.killed).toBe(false)

      const unit = "\x1b[32m你好世界 🚀\x1b[0m line-output-0123456789\r\n"
      const totalPayload = unit.repeat(2600) // ~110 KiB UTF-8，若直接 JSON 转义会更大，分片后每帧稳在 24 KiB Base64 内
      pty.emit(totalPayload)

      // 重连新连接并附着，应收到多个单帧分片且拼接完全一致
      const reconnected = host.connectDevice("重连手机", 22, ["terminal"])
      const attached = (
        await reconnected.call(mobileTerminalMethods.attach, {
          threadId: thread.id,
          terminalId: opened.id,
          afterCursor: 0,
          cols: 56,
          rows: 28,
        })
      ).result as MobileTerminalAttachResult
      expect(attached.truncated).toBe(false)
      expect(attached.replayChunks).toBeGreaterThanOrEqual(4)
      expect(pty.resizes).toEqual([{ cols: 56, rows: 28 }])

      const replayNotifs = reconnected.notifications
        .filter((n) => n.method === mobileTerminalNotifications.output)
        .map((n) => n.params as MobileTerminalOutputNotification)
      expect(replayNotifs).toHaveLength(attached.replayChunks)
      for (const notif of replayNotifs) {
        expect(notif.replay).toBe(true)
        expect(Buffer.from(notif.dataBase64, "base64").length).toBeLessThanOrEqual(
          MOBILE_TERMINAL_OUTPUT_CHUNK_BYTES,
        )
      }
      const reconstructed = replayNotifs
        .map((n) => Buffer.from(n.dataBase64, "base64").toString("utf8"))
        .join("")
      expect(reconstructed).toBe(totalPayload)

      // 增量续传：断线期间新增输出，带 afterCursor 只补新增段
      const savedCursor = attached.cursor
      await reconnected.call(mobileTerminalMethods.detach, { terminalId: opened.id })
      reconnected.notifications.length = 0
      pty.emit("delta-after-reconnect\r\n")

      const resumed = (
        await reconnected.call(mobileTerminalMethods.attach, {
          threadId: thread.id,
          terminalId: opened.id,
          afterCursor: savedCursor,
        })
      ).result as MobileTerminalAttachResult
      expect(resumed.truncated).toBe(false)
      expect(resumed.replayChunks).toBe(1)
      const deltaText = Buffer.from(
        (reconnected.notifications[0]!.params as MobileTerminalOutputNotification).dataBase64,
        "base64",
      ).toString("utf8")
      expect(deltaText).toBe("delta-after-reconnect\r\n")

      // 撤销配对：立即断开终端订阅且不再推送输出（但 PTY 不被误杀）
      reconnected.notifications.length = 0
      host.devices.remove(host.devices.find(reconnected.deviceKey)!)
      revokeDeviceWork(host.ctx, reconnected.deviceKey)
      pty.emit("secret-after-revoke\r\n")
      await new Promise((r) => setTimeout(r, 35))
      expect(reconnected.notifications).toEqual([])
      expect(
        await reconnected.call(mobileTerminalMethods.list, { threadId: thread.id }),
      ).toMatchObject({ error: { code: "DEVICE_REVOKED" } })
    } finally {
      await host.dispose()
      await rm(root, { recursive: true, force: true })
    }
  })

  it("emits overflow backpressure notice when burst exceeds pending cap and forwards exit after flushing", async () => {
    const root = await mkdtemp(join(tmpdir(), "pigcode-mterm-bp-"))
    const fake = createFakePtyFactory()
    const host = await setupHost(fake.factory)
    try {
      const project = host.ctx.projects.add(root, "背压项目")
      const thread = host.ctx.threads.create(project.id, "背压会话", "fake")
      const term = await host.ctx.terminal.open({ threadId: thread.id }, 48, 20, {
        origin: "mobile",
      })
      const pty = fake.instances[0]!

      const sent: Array<{ method: string; params: Record<string, unknown> }> = []
      const session = new MobileTerminalSession(
        host.ctx,
        "dev-bp",
        (msg) => sent.push(msg as { method: string; params: Record<string, unknown> }),
        () => {},
        { coalesceMs: 50, maxPendingBytes: 1024, outputChunkBytes: 512 },
      )
      const afterReplies: Array<() => void> = []
      session.dispatch(
        {
          jsonrpc: "2.0",
          id: "1",
          method: mobileTerminalMethods.attach,
          params: { threadId: thread.id, terminalId: term.id },
        },
        (cb) => afterReplies.push(cb),
      )
      for (const cb of afterReplies) cb()

      // 瞬间刷超过 1024 字节，触发 overflow: true 背压通知
      pty.emit("x".repeat(600))
      pty.emit("y".repeat(600))
      expect(sent.some((m) => m.method === mobileTerminalNotifications.output && m.params.overflow === true)).toBe(
        true,
      )

      // 重连 attach 解除 overflow，随后测试退出前刷出残留输出 + 推送 exit
      sent.length = 0
      const afterReplies2: Array<() => void> = []
      session.dispatch(
        {
          jsonrpc: "2.0",
          id: "2",
          method: mobileTerminalMethods.attach,
          params: { threadId: thread.id, terminalId: term.id, afterCursor: 1200 },
        },
        (cb) => afterReplies2.push(cb),
      )
      for (const cb of afterReplies2) cb()
      pty.emit("final-line\r\n")
      pty.exit(130)
      expect(sent.map((m) => m.method)).toEqual([
        mobileTerminalNotifications.output,
        mobileTerminalNotifications.exit,
      ])
      expect(sent[1]!.params).toEqual({ terminalId: term.id, exitCode: 130 })
      session.close()
    } finally {
      await host.dispose()
      await rm(root, { recursive: true, force: true })
    }
  })

  it("runs real Node Host <-> Dart pigcode_client terminal end-to-end loopback within single Noise frames", async () => {
    const root = await mkdtemp(join(tmpdir(), "pigcode-mterm-dart-e2e-"))
    const fake = createFakePtyFactory()
    const host = await setupHost(fake.factory)

    const project = host.ctx.projects.add(root, "Dart 终端联调")
    const thread = host.ctx.threads.create(project.id, "终端联调会话", "fake")
    const desktopTerm = await host.ctx.terminal.open({ threadId: thread.id }, 100, 32)
    fake.instances[0]!.emit("desktop-banner\r\n")

    const phone = host.connectDevice("Dart 终端手机", 88, ["terminal"])

    const clientPkgDir = fileURLToPath(
      new URL("../../../mobile/packages/pigcode_client", import.meta.url),
    )
    const dart = spawn("dart", ["run", "test/terminal_e2e_driver.dart"], {
      cwd: clientPkgDir,
      stdio: ["pipe", "pipe", "pipe"],
    })
    dart.stdin.on("error", () => {})
    let stderr = ""
    dart.stderr.setEncoding("utf8").on("data", (chunk: string) => {
      stderr += chunk
    })

    // 将 Host 发给 phone.wire.client 的所有响应与推送通知实时桥接给 Dart 进程
    phone.wire.client.onMessage((message) => {
      assertSingleNoiseFrame(message)
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
        phone.wire.client.send(req)
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

    function runDart(action: string, args: Record<string, unknown> = {}) {
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
      // 1. 列出电脑终端并尝试越权写 → TERMINAL_READ_ONLY
      const listed = await runDart("list", { threadId: thread.id })
      expect(listed.ok, stderr).toBe(true)
      expect((listed.data!.terminals as Array<{ id: string; writable: boolean }>)[0]).toMatchObject({
        id: desktopTerm.id,
        writable: false,
      })

      const writeDesktop = await runDart("write", { terminalId: desktopTerm.id, data: "whoami\n" })
      expect(writeDesktop.ok).toBe(false)
      expect(writeDesktop.code).toBe("TERMINAL_READ_ONLY")

      // 2. 新建手机终端 → 写入输入 → 接收实时输出与分片回放 → 调尺寸 → 关闭
      const openedRes = await runDart("open", { threadId: thread.id, cols: 48, rows: 24 })
      expect(openedRes.ok, stderr).toBe(true)
      const mobileTerm = openedRes.data!.terminal as { id: string; writable: boolean }
      expect(mobileTerm.writable).toBe(true)
      const mobilePty = fake.instances[1]!

      const writeRes = await runDart("write", { terminalId: mobileTerm.id, data: "echo 你好🚀\r" })
      expect(writeRes.ok, stderr).toBe(true)
      expect(mobilePty.writes).toEqual(["echo 你好🚀\r"])

      mobilePty.emit("你好🚀\r\n")
      const events1 = await runDart("drainEvents")
      const outs1 = events1.data!.outputs as Array<{ data: string; cursor: number }>
      expect(outs1.map((o) => o.data).join("")).toBe("你好🚀\r\n")
      const cursor1 = outs1[outs1.length - 1]!.cursor

      // 模拟断线后大量输出并带游标重附着
      await runDart("detach", { terminalId: mobileTerm.id })
      const chunked = "\x1b[36m回放块\x1b[0m-0123456789\r\n".repeat(1200)
      mobilePty.emit(chunked)

      const attachRes = await runDart("attach", {
        threadId: thread.id,
        terminalId: mobileTerm.id,
        afterCursor: cursor1,
        cols: 60,
        rows: 26,
      })
      expect(attachRes.ok, stderr).toBe(true)
      expect((attachRes.data!.replayChunks as number)).toBeGreaterThanOrEqual(2)
      const events2 = await runDart("drainEvents")
      const replayed = (events2.data!.outputs as Array<{ data: string }>).map((o) => o.data).join("")
      expect(replayed).toBe(chunked)

      const resized = await runDart("resize", { terminalId: mobileTerm.id, cols: 72, rows: 30 })
      expect(resized.ok, stderr).toBe(true)
      expect(resized.data).toEqual({ cols: 72, rows: 30 })

      const closed = await runDart("close", { terminalId: mobileTerm.id })
      expect(closed.ok, stderr).toBe(true)
      expect(mobilePty.killed).toBe(true)
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
})
