/** 手机端工作台只读与 Dart E2E 测试共享辅助工具。 */
import { spawn } from "node:child_process"
import { randomUUID } from "node:crypto"
import { createInterface } from "node:readline"
import { fileURLToPath } from "node:url"
import { Context } from "cordis"
import { expect } from "vitest"
import { apply as agents } from "../agents/registry"
import { MemoryTransport } from "../rpc/memory-transport"
import { ThreadFeed } from "../rpc/thread-feed"
import { apply as attachmentsPlugin, type AttachmentThumbnailer } from "../services/attachments"
import { currentBranch } from "../services/git"
import { GithubService, type BranchReader, type GhRunner } from "../services/github"
import { apply as projects } from "../services/projects"
import { apply as sessions } from "../services/sessions"
import { apply as settings } from "../services/settings"
import { apply as storage } from "../services/storage"
import { apply as threads } from "../services/threads"
import { apply as workspace } from "../services/workspace"
import { scopeCwd } from "../services/worktrees"
import { mobileFrames } from "./mobile-frames"
import { PairedDevices } from "./paired-devices"
import { MobileSidebarRpc } from "./sidebar-rpc"

export const MAX_NOISE_ENCRYPTED_FRAME_BYTES = 65_535
export const NOISE_TAG_BYTES = 16

export function assertSingleNoiseFrame(message: unknown): void {
  const frames = [...mobileFrames(message)]
  expect(frames).toHaveLength(1)
  expect(frames[0]!.length + NOISE_TAG_BYTES).toBeLessThanOrEqual(MAX_NOISE_ENCRYPTED_FRAME_BYTES)
}

export function makePng(totalBytes: number, width = 1280, height = 720): Buffer {
  const buf = Buffer.alloc(Math.max(33, totalBytes))
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(buf, 0)
  buf.writeUInt32BE(13, 8)
  buf.write("IHDR", 12, "ascii")
  buf.writeUInt32BE(width, 16)
  buf.writeUInt32BE(height, 20)
  for (let i = 33; i < buf.length; i++) {
    buf[i] = (i * 29 + 13) & 0xff
  }
  return buf
}

export function makeJpeg(totalBytes: number, width = 360, height = 202): Buffer {
  const buf = Buffer.alloc(Math.max(20, totalBytes))
  buf[0] = 0xff
  buf[1] = 0xd8
  buf[2] = 0xff
  buf[3] = 0xc0
  buf.writeUInt16BE(11, 4)
  buf[6] = 8
  buf.writeUInt16BE(height, 7)
  buf.writeUInt16BE(width, 9)
  buf[11] = 3
  for (let i = 15; i < buf.length - 2; i++) {
    buf[i] = (i * 19 + 5) & 0xff
  }
  buf[buf.length - 2] = 0xff
  buf[buf.length - 1] = 0xd9
  return buf
}

export function commandError(fields: { stderr?: string; code?: string }): Error {
  return Object.assign(new Error(fields.stderr ?? "gh command failed"), fields)
}

export interface ClientHandle {
  deviceKey: string
  wire: MemoryTransport
  call(
    method: string,
    params?: Record<string, unknown>,
  ): Promise<{ id: string; result?: unknown; error?: { code: string; message: string } }>
  stop(): void
}

export async function setupWorkbenchReadHost(options?: {
  thumbnailer?: AttachmentThumbnailer
  ghRunner?: GhRunner
  branchReader?: BranchReader
}) {
  const ctx = new Context()
  await ctx.plugin(storage, { path: ":memory:" })
  await ctx.plugin(
    attachmentsPlugin,
    options?.thumbnailer ? { thumbnailer: options.thumbnailer } : {},
  )
  await ctx.plugin(settings, {})
  await ctx.plugin(projects)
  await ctx.plugin(threads)
  await ctx.plugin(sessions)
  await ctx.plugin(workspace)
  await ctx.plugin(agents)
  ctx.provide(
    "github",
    new GithubService(
      options?.ghRunner ?? (async () => ""),
      (scope) => scopeCwd(ctx, scope),
      options?.branchReader ?? currentBranch,
    ),
  )

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
    wire.client.onMessage((message) => {
      const record = message as { id?: string }
      if (record.id && replies.has(record.id)) {
        const resolve = replies.get(record.id)!
        replies.delete(record.id)
        resolve(message)
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
      async call(method: string, params: Record<string, unknown> = {}) {
        const id = randomUUID()
        const request = { jsonrpc: "2.0", id, method, params }
        assertSingleNoiseFrame(request)
        const replyPromise = new Promise<unknown>((resolve) => replies.set(id, resolve))
        wire.client.send(request)
        const reply = (await replyPromise) as {
          id: string
          result?: unknown
          error?: { code: string; message: string }
        }
        assertSingleNoiseFrame(reply)
        return reply
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
      ctx.agents.cancelAll()
      await ctx.fiber.dispose()
    },
  }
}

export interface DartDriverReply {
  ok: boolean
  data?: Record<string, unknown>
  error?: string
  code?: string
}

export function startDartWorkbenchDriver(phone: ClientHandle, driverScript: string) {
  const clientPkgDir = fileURLToPath(
    new URL("../../../mobile/packages/pigcode_client", import.meta.url),
  )
  const dart = spawn("dart", ["run", driverScript], {
    cwd: clientPkgDir,
    stdio: ["pipe", "pipe", "pipe"],
  })
  dart.stdin.on("error", () => {})
  let stderr = ""
  dart.stderr.setEncoding("utf8").on("data", (chunk: string) => {
    stderr += chunk
  })

  const cmdWaiters = new Map<string, (res: DartDriverReply) => void>()
  let maxOutboundEncryptedBytes = 0
  let maxInboundEncryptedBytes = 0
  let maxFrameCount = 0

  phone.wire.client.onMessage((message) => {
    const record = message as { id?: string; result?: unknown; error?: unknown }
    if (!record.id) return
    const frames = [...mobileFrames(message)]
    maxFrameCount = Math.max(maxFrameCount, frames.length)
    for (const frame of frames) {
      maxInboundEncryptedBytes = Math.max(maxInboundEncryptedBytes, frame.length + NOISE_TAG_BYTES)
    }
    dart.stdin.write(
      JSON.stringify({
        dir: "rpc_res",
        id: record.id,
        ...(record.error !== undefined ? { error: record.error } : { result: record.result }),
      }) + "\n",
    )
  })

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
      error?: string
      code?: string
    }
    if (msg.dir === "rpc_req") {
      const req = {
        jsonrpc: "2.0",
        id: msg.id!,
        method: msg.method!,
        params: msg.params ?? {},
      }
      const frames = [...mobileFrames(req)]
      maxFrameCount = Math.max(maxFrameCount, frames.length)
      for (const frame of frames) {
        maxOutboundEncryptedBytes = Math.max(
          maxOutboundEncryptedBytes,
          frame.length + NOISE_TAG_BYTES,
        )
      }
      phone.wire.client.send(req)
    } else if (msg.dir === "cmd_res" && msg.cmdId) {
      const resolve = cmdWaiters.get(msg.cmdId)
      if (resolve) {
        cmdWaiters.delete(msg.cmdId)
        resolve({
          ok: msg.ok === true,
          ...(msg.data !== undefined ? { data: msg.data } : {}),
          ...(msg.error !== undefined ? { error: msg.error } : {}),
          ...(msg.code !== undefined ? { code: msg.code } : {}),
        })
      }
    }
  })

  function cmd(action: string, args: Record<string, unknown> = {}) {
    const cmdId = randomUUID()
    return new Promise<DartDriverReply>((resolve, reject) => {
      const onExit = (code: number | null) => {
        cmdWaiters.delete(cmdId)
        reject(new Error(`Dart driver exited (${code}): ${stderr}`))
      }
      dart.once("exit", onExit)
      cmdWaiters.set(cmdId, (res) => {
        dart.off("exit", onExit)
        resolve(res)
      })
      dart.stdin.write(JSON.stringify({ dir: "cmd", cmdId, action, args }) + "\n")
    })
  }

  return {
    cmd,
    stats() {
      return {
        maxFrameCount,
        maxOutboundEncryptedBytes,
        maxInboundEncryptedBytes,
      }
    },
    close() {
      if (!dart.stdin.destroyed && dart.exitCode === null) {
        dart.stdin.write(JSON.stringify({ dir: "exit" }) + "\n")
        dart.stdin.end()
      }
      rl.close()
      dart.kill()
    },
  }
}
