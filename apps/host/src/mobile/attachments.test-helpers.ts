import { createHash, randomUUID } from "node:crypto"
import {
  MOBILE_ATTACHMENT_CHUNK_BYTES,
  mobileAttachmentMethods,
  type MobileAttachmentReadResult,
} from "@pigcode/contracts"
import { Context } from "cordis"
import { expect } from "vitest"
import type { AgentDriver, AgentSessionHandle, UserInput } from "../agents/driver"
import { FakeAgentDriver, FAKE_MODELS } from "../agents/fake"
import { apply as agents } from "../agents/registry"
import { MemoryTransport } from "../rpc/memory-transport"
import { ThreadFeed } from "../rpc/thread-feed"
import { apply as attachmentsPlugin, type AttachmentThumbnailer } from "../services/attachments"
import { apply as projects } from "../services/projects"
import { apply as sessions } from "../services/sessions"
import { apply as settings } from "../services/settings"
import { apply as storage } from "../services/storage"
import { apply as threads } from "../services/threads"
import { mobileFrames } from "./mobile-frames"
import { PairedDevices } from "./paired-devices"
import { MobileSidebarRpc } from "./sidebar-rpc"

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

export function makeJpeg(totalBytes: number, width = 800, height = 600): Buffer {
  // Minimal valid JPEG SOI + SOF0 header + padding + EOI.
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
    buf[i] = (i * 17 + 3) & 0xff
  }
  buf[buf.length - 2] = 0xff
  buf[buf.length - 1] = 0xd9
  return buf
}

export function sha256Hex(buffer: Buffer): string {
  return createHash("sha256").update(buffer).digest("hex")
}

export function createVisionDriver(id: string, images: boolean) {
  const inputs: UserInput[] = []
  let sessionSeq = 0
  let releaseGate: (() => void) | undefined
  let gate: Promise<void> | undefined
  const fixture = new FakeAgentDriver()
  const driver: AgentDriver = {
    id,
    displayName: `Driver ${id}`,
    features: { ...fixture.features, images },
    executionModes: { plan: true },
    detect: () => fixture.detect(),
    listModels: async () => FAKE_MODELS,
    async createSession(input) {
      return {
        id: input.sessionId ?? `ps_${id}_${++sessionSeq}`,
        threadId: input.threadId,
        cwd: input.cwd,
        nativeSessionId: input.nativeSessionId ?? null,
        permissionMode: input.permissionMode ?? "full-access",
        model: input.model ?? null,
      }
    },
    async send(_session: AgentSessionHandle, input, runtime) {
      inputs.push(input)
      if (gate) await gate
      runtime.emit({ type: "message.completed", text: `${id}:${input.text}` })
      runtime.emit({ type: "run.completed" })
    },
    interrupt: async () => undefined,
    dispose: async () => undefined,
  }
  return {
    driver,
    inputs,
    block() {
      gate = new Promise<void>((resolve) => {
        releaseGate = resolve
      })
    },
    unblock() {
      releaseGate?.()
      gate = undefined
    },
  }
}

export interface ClientHandle {
  deviceKey: string
  mobile: MobileSidebarRpc
  wire: MemoryTransport
  notifications: unknown[]
  call(
    method: string,
    params?: Record<string, unknown>,
  ): Promise<{ id: string; result?: unknown; error?: { code: string; message: string } }>
  stop(): void
}

export async function setupAttachmentHost(options?: {
  thumbnailer?: AttachmentThumbnailer
  extraDrivers?: AgentDriver[]
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
  await ctx.plugin(agents)
  for (const driver of options?.extraDrivers ?? []) ctx.agents.register(driver)

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
    const notifications: unknown[] = []
    wire.client.onMessage((message) => {
      const record = message as { id?: string; method?: string }
      if (record.id && replies.has(record.id)) {
        const resolve = replies.get(record.id)!
        replies.delete(record.id)
        resolve(message)
      } else if (record.method) {
        notifications.push(message)
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
      mobile,
      wire,
      notifications,
      async call(method: string, params: Record<string, unknown> = {}) {
        const id = randomUUID()
        const request = { jsonrpc: "2.0", id, method, params }
        // 每条手机端发往 Host 的附件分片消息必须满足 Go 中继单帧限制。
        expect([...mobileFrames(request)]).toHaveLength(1)
        const replyPromise = new Promise<unknown>((resolve) => replies.set(id, resolve))
        wire.client.send(request)
        const reply = (await replyPromise) as {
          id: string
          result?: unknown
          error?: { code: string; message: string }
        }
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
    feed,
    devices,
    connectDevice,
    async dispose() {
      for (const client of clients) client.stop()
      ctx.agents.cancelAll()
      await ctx.fiber.dispose()
    },
  }
}

export async function uploadConcurrent(
  client: ClientHandle,
  buffer: Buffer,
  mimeType: "image/png" | "image/jpeg" | "image/webp" | "image/gif",
  fileName: string,
  options?: { uploadId?: string; sha256?: string },
) {
  const uploadId = options?.uploadId ?? randomUUID()
  const start = await client.call(mobileAttachmentMethods.uploadStart, {
    uploadId,
    mimeType,
    fileName,
    totalBytes: buffer.length,
    sha256: options?.sha256 ?? sha256Hex(buffer),
  })
  expect(start.error).toBeUndefined()
  expect(start.result).toEqual({ uploadId, chunkBytes: MOBILE_ATTACHMENT_CHUNK_BYTES })

  const chunks: Array<{ offset: number; slice: Buffer }> = []
  for (let offset = 0; offset < buffer.length; offset += MOBILE_ATTACHMENT_CHUNK_BYTES) {
    chunks.push({
      offset,
      slice: buffer.subarray(
        offset,
        Math.min(offset + MOBILE_ATTACHMENT_CHUNK_BYTES, buffer.length),
      ),
    })
  }
  // 逆序并发发送，验证 4 路并发乱序重组。
  const ordered = [...chunks].reverse()
  await Promise.all(
    ordered.map(async ({ offset, slice }) => {
      const res = await client.call(mobileAttachmentMethods.uploadChunk, {
        uploadId,
        offset,
        dataBase64: slice.toString("base64"),
      })
      expect(res.error).toBeUndefined()
    }),
  )

  return client.call(mobileAttachmentMethods.uploadFinish, { uploadId })
}

export async function readAllChunks(
  client: ClientHandle,
  attachmentId: string,
  variant: "thumb" | "full",
  threadId?: string,
) {
  const pieces: Buffer[] = []
  let offset: number | undefined
  let callCount = 0
  let lastResult!: MobileAttachmentReadResult
  for (;;) {
    callCount++
    const res = await client.call(mobileAttachmentMethods.read, {
      ...(threadId !== undefined ? { threadId } : {}),
      attachmentId,
      variant,
      ...(offset !== undefined ? { offset } : {}),
    })
    expect(res.error).toBeUndefined()
    // 验证每一帧响应都在单帧 65,535 字节 Noise 限制以内。
    expect([...mobileFrames(res)]).toHaveLength(1)
    const page = res.result as MobileAttachmentReadResult
    lastResult = page
    pieces.push(Buffer.from(page.dataBase64, "base64"))
    if (page.nextOffset === undefined) break
    offset = page.nextOffset
  }
  return {
    bytes: Buffer.concat(pieces),
    mimeType: lastResult.mimeType,
    attachment: lastResult.attachment,
    callCount,
  }
}
