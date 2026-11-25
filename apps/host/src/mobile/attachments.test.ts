import { spawn } from "node:child_process"
import { createHash, randomUUID } from "node:crypto"
import { existsSync } from "node:fs"
import { join } from "node:path"
import { createInterface } from "node:readline"
import { fileURLToPath } from "node:url"
import {
  MOBILE_ATTACHMENT_CHUNK_BYTES,
  MOBILE_MAX_IMAGE_BYTES,
  MOBILE_THUMBNAIL_MAX_BYTES,
  mobileAttachmentMethods,
  mobileFeatures,
  type ImageAttachmentRef,
  type MobileAttachmentReadResult,
} from "@pigcode/contracts"
import { Context } from "cordis"
import { describe, expect, it } from "vitest"
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
import { AttachmentStore } from "../storage/attachment-store"
import { MOBILE_MAX_CONCURRENT_UPLOADS, MobileAttachments } from "./attachments"
import { mobileFrames } from "./mobile-frames"
import { PairedDevices } from "./paired-devices"
import { revokeDeviceWork } from "./revocation"
import { MobileSidebarRpc } from "./sidebar-rpc"

function makePng(totalBytes: number, width = 1280, height = 720): Buffer {
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

function makeJpeg(totalBytes: number, width = 800, height = 600): Buffer {
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

function sha256Hex(buffer: Buffer): string {
  return createHash("sha256").update(buffer).digest("hex")
}

function createVisionDriver(id: string, images: boolean) {
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

interface ClientHandle {
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

async function setupHost(options?: {
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

async function uploadConcurrent(
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
      slice: buffer.subarray(offset, Math.min(offset + MOBILE_ATTACHMENT_CHUNK_BYTES, buffer.length)),
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

async function readAllChunks(
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

describe("mobile composer.attachments protocol & Host implementation", () => {
  it("uploads >100 KiB PNG/JPEG concurrently out-of-order, sends image-only runs & drafts with idempotency, and reads thumb/full byte-identically", async () => {
    expect(mobileFeatures).toContain("composer.attachments")
    const vision = createVisionDriver("vision-agent", true)
    const noVision = createVisionDriver("text-only-agent", false)
    const fakeThumb = makeJpeg(14 * 1024, 360, 202)
    const host = await setupHost({
      thumbnailer: async () => fakeThumb,
      extraDrivers: [vision.driver, noVision.driver],
    })
    try {
      const project = host.ctx.projects.add("/tmp/pigcode-mobile-att-main", "图片项目")
      const thread = host.ctx.threads.create(project.id, "新会话", "vision-agent")
      const phone = host.connectDevice("主手机", 10, [
        "timeline.read",
        "run.write",
        "draft.write",
        "queue.write",
        "composer.controls",
        "composer.attachments",
      ])

      // draftOptions 正确投影 supportsImages。
      const draftOpts = await phone.call("thread.draftOptions")
      expect(draftOpts.result).toMatchObject({
        instances: expect.arrayContaining([
          expect.objectContaining({ instanceId: "vision-agent", supportsImages: true }),
          expect.objectContaining({ instanceId: "text-only-agent", supportsImages: false }),
        ]),
      })

      // thread.subscribe 与 composer 命令投影 supportsImages。
      const sub = await phone.call("thread.subscribe", { threadId: thread.id })
      expect(sub.result).toMatchObject({
        composer: expect.objectContaining({ agentId: "vision-agent", supportsImages: true }),
      })

      // 4 路并发乱序上传一张 > 100 KiB 真实 PNG。
      const largePng = makePng(115 * 1024, 1440, 960)
      const finishPng = await uploadConcurrent(phone, largePng, "image/png", "crash-log.png")
      expect(finishPng.error).toBeUndefined()
      const pngRef = (finishPng.result as { attachment: ImageAttachmentRef }).attachment
      expect(pngRef).toMatchObject({
        id: expect.stringMatching(/^att_/),
        mimeType: "image/png",
        fileName: "crash-log.png",
        sizeBytes: largePng.length,
        width: 1440,
        height: 960,
      })

      // 纯图空文本发送 + commandId 幂等重试 + 参数冲突检测。
      const runCmdId = randomUUID()
      const runParams = {
        commandId: runCmdId,
        threadId: thread.id,
        text: "",
        attachmentIds: [pngRef.id],
      }
      const run1 = await phone.call("run.start", runParams)
      expect(run1.error).toBeUndefined()
      expect(run1.result).toMatchObject({ commandId: runCmdId, threadId: thread.id })
      // 相同 commandId 与相同 attachmentIds -> 幂等返回同一回执。
      expect((await phone.call("run.start", runParams)).result).toEqual(run1.result)
      // 相同 commandId 但不同 attachmentIds -> COMMAND_ID_CONFLICT。
      expect(
        await phone.call("run.start", { ...runParams, attachmentIds: ["att_other"] }),
      ).toMatchObject({ error: { code: "COMMAND_ID_CONFLICT" } })

      await expect.poll(() => vision.inputs.length).toBe(1)
      expect(vision.inputs[0]?.text).toBe("")
      expect(vision.inputs[0]?.attachments?.[0]?.id).toBe(pngRef.id)
      expect(host.ctx.threads.get(thread.id)?.title).toBe("crash-log.png")

      // 时间线实时推送 message.user 包含轻量 attachments 元数据且不泄露本机路径。
      const userEvent = host.ctx.sessions
        .read(thread.id, 0)
        .find((e) => e.type === "message.completed" && (e.payload as { role?: string }).role === "user")
      expect(userEvent?.payload).toMatchObject({ role: "user", text: "", attachments: [pngRef] })
      const userNotice = phone.notifications.find(
        (n) =>
          (n as { method?: string; params?: { event?: { kind?: string } } }).method ===
            "thread.event" &&
          (n as { params?: { event?: { kind?: string } } }).params?.event?.kind === "message.user",
      ) as { params?: { event?: { attachments?: ImageAttachmentRef[] } } } | undefined
      expect(userNotice?.params?.event?.attachments).toEqual([pngRef])

      // 读取 thumb（<= 40 KiB 单帧直达）与分片读取 full（100% 字节一致）。
      const thumbRead = await readAllChunks(phone, pngRef.id, "thumb", thread.id)
      expect(thumbRead.callCount).toBe(1)
      expect(thumbRead.mimeType).toBe("image/jpeg")
      expect(thumbRead.bytes.equals(fakeThumb)).toBe(true)

      const fullRead = await readAllChunks(phone, pngRef.id, "full", thread.id)
      expect(fullRead.callCount).toBe(Math.ceil(largePng.length / MOBILE_ATTACHMENT_CHUNK_BYTES))
      expect(fullRead.mimeType).toBe("image/png")
      expect(fullRead.bytes.equals(largePng)).toBe(true)

      // 切换为不支持原生看图的 Agent 时，composer 投影 supportsImages: false。
      await expect.poll(() => host.ctx.agents.listRuns()).toEqual([])
      const switched = await phone.call("thread.switchAgent", {
        threadId: thread.id,
        instanceId: "text-only-agent",
      })
      expect(switched.result).toMatchObject({
        agentId: "text-only-agent",
        supportsImages: false,
      })

      // 草稿带图创建新会话（JPEG > 100 KiB，纯图空文本 + 幂等重试）。
      const largeJpeg = makeJpeg(108 * 1024, 1024, 768)
      const finishJpeg = await uploadConcurrent(phone, largeJpeg, "image/jpeg", "photo.jpg")
      const jpegRef = (finishJpeg.result as { attachment: ImageAttachmentRef }).attachment
      const draftCmdId = randomUUID()
      const draftParams = {
        commandId: draftCmdId,
        projectId: project.id,
        instanceId: "vision-agent",
        permissionMode: "full-access",
        text: "",
        attachmentIds: [jpegRef.id],
      }
      const created = await phone.call("thread.create", draftParams)
      expect(created.error).toBeUndefined()
      expect((await phone.call("thread.create", draftParams)).result).toEqual(created.result)
      expect(
        await phone.call("thread.create", { ...draftParams, attachmentIds: ["att_other"] }),
      ).toMatchObject({ error: { code: "COMMAND_ID_CONFLICT" } })
      await expect.poll(() => vision.inputs.length).toBe(2)
      expect(vision.inputs[1]?.attachments?.[0]?.id).toBe(jpegRef.id)
      const draftThreadId = (created.result as { threadId: string }).threadId
      const draftFull = await readAllChunks(phone, jpegRef.id, "full", draftThreadId)
      expect(draftFull.bytes.equals(largeJpeg)).toBe(true)
    } finally {
      await host.dispose()
    }
  })

  it("chunks thumb reads within single-frame limit when no thumbnailer is available and original exceeds 40 KiB", async () => {
    const host = await setupHost()
    try {
      const phone = host.connectDevice("无缩略图器手机", 12, ["composer.attachments"])
      const bigPng = makePng(MOBILE_THUMBNAIL_MAX_BYTES + 60 * 1024, 1600, 1200)
      const finish = await uploadConcurrent(phone, bigPng, "image/png", "large.png")
      const ref = (finish.result as { attachment: ImageAttachmentRef }).attachment

      const thumb = await readAllChunks(phone, ref.id, "thumb")
      expect(thumb.callCount).toBeGreaterThan(1)
      expect(thumb.mimeType).toBe("image/png")
      expect(thumb.bytes.equals(bigPng)).toBe(true)
    } finally {
      await host.dispose()
    }
  })

  it("rejects cancel/hash mismatch/spoofed SVG/bad magic/oversized/duplicate/overlapping/incomplete uploads and enforces device quotas", async () => {
    const host = await setupHost()
    try {
      const phone = host.connectDevice("安全测试手机", 15, ["composer.attachments"])

      // 1. 单张 > 4 MiB 拒绝。
      expect(
        await phone.call(mobileAttachmentMethods.uploadStart, {
          uploadId: "up_too_big",
          mimeType: "image/png",
          totalBytes: MOBILE_MAX_IMAGE_BYTES + 1,
          sha256: "a".repeat(64),
        }),
      ).toMatchObject({ error: { code: "ATTACHMENT_TOO_LARGE" } })

      // 2. 声明 SVG MIME 拒绝。
      expect(
        await phone.call(mobileAttachmentMethods.uploadStart, {
          uploadId: "up_svg_mime",
          mimeType: "image/svg+xml",
          totalBytes: 32,
          sha256: "a".repeat(64),
        }),
      ).toMatchObject({ error: { code: "ATTACHMENT_UNSUPPORTED_TYPE" } })

      // 3. 伪造 SVG（声明为 image/png）在 finish 魔数校验被拒。
      const svgPayload = Buffer.from("<svg xmlns='http://www.w3.org/2000/svg'><script/></svg>")
      expect(await uploadConcurrent(phone, svgPayload, "image/png", "evil.png")).toMatchObject({
        error: { code: "ATTACHMENT_UNSUPPORTED_TYPE" },
      })

      // 4. 真实 PNG 但声明 image/jpeg 在 finish 格式核对被拒。
      const validPng = makePng(1024)
      expect(await uploadConcurrent(phone, validPng, "image/jpeg", "fake.jpg")).toMatchObject({
        error: { code: "ATTACHMENT_UNSUPPORTED_TYPE" },
      })

      // 5. SHA-256 不匹配被拒。
      expect(
        await uploadConcurrent(phone, validPng, "image/png", "bad-sha.png", {
          sha256: "0".repeat(64),
        }),
      ).toMatchObject({ error: { code: "ATTACHMENT_HASH_MISMATCH" } })

      // 6. 取消上传幂等生效并立即释放槽位。
      const cancelId = "up_cancel_test"
      expect(
        await phone.call(mobileAttachmentMethods.uploadStart, {
          uploadId: cancelId,
          mimeType: "image/png",
          totalBytes: 1024,
          sha256: sha256Hex(validPng),
        }),
      ).toMatchObject({ result: { uploadId: cancelId } })
      expect(
        await phone.call(mobileAttachmentMethods.uploadCancel, { uploadId: cancelId }),
      ).toMatchObject({ result: { ok: true } })
      // 再次取消幂等返回 ok: true。
      expect(
        await phone.call(mobileAttachmentMethods.uploadCancel, { uploadId: cancelId }),
      ).toMatchObject({ result: { ok: true } })
      // 取消后再发分片返回 ATTACHMENT_NOT_FOUND。
      expect(
        await phone.call(mobileAttachmentMethods.uploadChunk, {
          uploadId: cancelId,
          offset: 0,
          dataBase64: validPng.subarray(0, 64).toString("base64"),
        }),
      ).toMatchObject({ error: { code: "ATTACHMENT_NOT_FOUND" } })

      // 7. 重复 uploadId、重叠写入、缺片 finish 拒绝（且 finish 失败后清理缓冲）。
      const dupId = "up_overlap"
      await phone.call(mobileAttachmentMethods.uploadStart, {
        uploadId: dupId,
        mimeType: "image/png",
        totalBytes: 200,
        sha256: sha256Hex(makePng(200)),
      })
      expect(
        await phone.call(mobileAttachmentMethods.uploadStart, {
          uploadId: dupId,
          mimeType: "image/png",
          totalBytes: 200,
          sha256: sha256Hex(makePng(200)),
        }),
      ).toMatchObject({ error: { code: "INVALID_PARAMS" } })
      expect(
        await phone.call(mobileAttachmentMethods.uploadChunk, {
          uploadId: dupId,
          offset: 0,
          dataBase64: Buffer.alloc(100, 1).toString("base64"),
        }),
      ).toMatchObject({ result: { receivedBytes: 100 } })
      // 重复写同一区间或部分重叠写必须拒绝。
      expect(
        await phone.call(mobileAttachmentMethods.uploadChunk, {
          uploadId: dupId,
          offset: 50,
          dataBase64: Buffer.alloc(80, 2).toString("base64"),
        }),
      ).toMatchObject({ error: { code: "INVALID_PARAMS" } })
      // 缺片 finish 拒绝并释放缓冲。
      expect(
        await phone.call(mobileAttachmentMethods.uploadFinish, { uploadId: dupId }),
      ).toMatchObject({ error: { code: "INVALID_PARAMS" } })
      expect(
        await phone.call(mobileAttachmentMethods.uploadFinish, { uploadId: dupId }),
      ).toMatchObject({ error: { code: "ATTACHMENT_NOT_FOUND" } })

      // 8. 单设备并发上传会话限流 <= 4。
      const activeIds: string[] = []
      for (let i = 0; i < MOBILE_MAX_CONCURRENT_UPLOADS; i++) {
        const id = `up_quota_${i}`
        activeIds.push(id)
        expect(
          await phone.call(mobileAttachmentMethods.uploadStart, {
            uploadId: id,
            mimeType: "image/png",
            totalBytes: 1024,
            sha256: "b".repeat(64),
          }),
        ).toMatchObject({ result: { uploadId: id } })
      }
      expect(
        await phone.call(mobileAttachmentMethods.uploadStart, {
          uploadId: "up_quota_5",
          mimeType: "image/png",
          totalBytes: 1024,
          sha256: "b".repeat(64),
        }),
      ).toMatchObject({ error: { code: "ATTACHMENT_LIMIT_EXCEEDED" } })

      // 9. 单设备未完成上传总字节上限（独立构造带小字节配额实例验证）。
      const tight = new MobileAttachments(host.ctx, "tight_device", () => {}, {
        maxConcurrentUploads: 10,
        maxInFlightBytes: 2048,
      })
      try {
        tight.dispatch({
          jsonrpc: "2.0",
          id: "1",
          method: mobileAttachmentMethods.uploadStart,
          params: {
            uploadId: "tight_1",
            mimeType: "image/png",
            totalBytes: 1500,
            sha256: "c".repeat(64),
          },
        })
        expect(() =>
          tight.dispatch({
            jsonrpc: "2.0",
            id: "2",
            method: mobileAttachmentMethods.uploadStart,
            params: {
              uploadId: "tight_2",
              mimeType: "image/png",
              totalBytes: 600,
              sha256: "c".repeat(64),
            },
          }),
        ).toThrowError()
      } finally {
        tight.close()
      }

      // 清理前面 4 个配额上传。
      for (const id of activeIds) {
        await phone.call(mobileAttachmentMethods.uploadCancel, { uploadId: id })
      }
    } finally {
      await host.dispose()
    }
  })

  it("enforces cross-device isolation, deleted-project thread guards, disconnect cleanup, and pairing revocation cleanup", async () => {
    const vision = createVisionDriver("vision-iso", true)
    const host = await setupHost({ extraDrivers: [vision.driver] })
    try {
      const project = host.ctx.projects.add("/tmp/pigcode-mobile-att-ok", "正常项目")
      const removedProject = host.ctx.projects.add("/tmp/pigcode-mobile-att-del", "待删项目")
      const threadA = host.ctx.threads.create(project.id, "会话 A", "vision-iso")
      const threadB = host.ctx.threads.create(project.id, "会话 B", "vision-iso")
      const subagent = host.ctx.threads.create(project.id, "子代理", "vision-iso", threadA.id)
      const hiddenThread = host.ctx.threads.create(removedProject.id, "已删会话", "vision-iso")

      const phoneA = host.connectDevice("手机 A", 21, ["composer.attachments", "run.write"])
      const phoneB = host.connectDevice("手机 B", 22, ["composer.attachments", "run.write"])

      // 设备 A 的进行中上传不能被设备 B 写入、取消或完成。
      const png = makePng(2048)
      const upId = "up_owned_by_A"
      await phoneA.call(mobileAttachmentMethods.uploadStart, {
        uploadId: upId,
        mimeType: "image/png",
        totalBytes: png.length,
        sha256: sha256Hex(png),
      })
      expect(
        await phoneB.call(mobileAttachmentMethods.uploadChunk, {
          uploadId: upId,
          offset: 0,
          dataBase64: png.toString("base64"),
        }),
      ).toMatchObject({ error: { code: "ATTACHMENT_FORBIDDEN" } })
      expect(
        await phoneB.call(mobileAttachmentMethods.uploadCancel, { uploadId: upId }),
      ).toMatchObject({ error: { code: "ATTACHMENT_FORBIDDEN" } })
      expect(
        await phoneB.call(mobileAttachmentMethods.uploadFinish, { uploadId: upId }),
      ).toMatchObject({ error: { code: "ATTACHMENT_FORBIDDEN" } })

      // 设备 A 断开连接时，进行中的上传缓冲立即释放。
      phoneA.stop()
      const phoneA2 = host.connectDevice("手机 A", 21, ["composer.attachments", "run.write"])
      expect(
        await phoneA2.call(mobileAttachmentMethods.uploadChunk, {
          uploadId: upId,
          offset: 0,
          dataBase64: png.toString("base64"),
        }),
      ).toMatchObject({ error: { code: "ATTACHMENT_NOT_FOUND" } })

      // 设备 A 上传完成进入 staging，设备 B 不能越权读取设备 A 的 staging 附件。
      const stagingRes = await uploadConcurrent(phoneA2, png, "image/png", "private-staging.png")
      const stagingRef = (stagingRes.result as { attachment: ImageAttachmentRef }).attachment
      expect(
        await phoneB.call(mobileAttachmentMethods.read, {
          attachmentId: stagingRef.id,
          variant: "full",
        }),
      ).toMatchObject({ error: { code: "ATTACHMENT_FORBIDDEN" } })
      // 设备 A 自己可以读取自己的 staging 附件。
      expect(
        await phoneA2.call(mobileAttachmentMethods.read, {
          attachmentId: stagingRef.id,
          variant: "full",
        }),
      ).toMatchObject({ result: { totalBytes: png.length } })

      // 提交到不同线程与已删项目会话、子代理会话后校验严格读权限。
      const committedInA = host.ctx.attachments.saveStaging({ buffer: png, fileName: "a.png" })
      host.ctx.attachments.commitForThread([committedInA.id], threadA.id)
      const committedInHidden = host.ctx.attachments.saveStaging({
        buffer: png,
        fileName: "hidden.png",
      })
      host.ctx.attachments.commitForThread([committedInHidden.id], hiddenThread.id)
      const committedInSub = host.ctx.attachments.saveStaging({ buffer: png, fileName: "sub.png" })
      host.ctx.attachments.commitForThread([committedInSub.id], subagent.id)
      host.ctx.projects.remove(removedProject.id)

      // 传错 threadId -> ATTACHMENT_FORBIDDEN。
      expect(
        await phoneB.call(mobileAttachmentMethods.read, {
          threadId: threadB.id,
          attachmentId: committedInA.id,
          variant: "full",
        }),
      ).toMatchObject({ error: { code: "ATTACHMENT_FORBIDDEN" } })

      // 已删除项目会话附件：传 threadId 与不传 threadId 都必须拒绝！
      expect(
        await phoneB.call(mobileAttachmentMethods.read, {
          threadId: hiddenThread.id,
          attachmentId: committedInHidden.id,
          variant: "full",
        }),
      ).toMatchObject({ error: { code: "RESOURCE_NOT_AVAILABLE" } })
      expect(
        await phoneB.call(mobileAttachmentMethods.read, {
          attachmentId: committedInHidden.id,
          variant: "full",
        }),
      ).toMatchObject({ error: { code: "RESOURCE_NOT_AVAILABLE" } })

      // 子代理会话附件：不传 threadId 也必须拒绝！
      expect(
        await phoneB.call(mobileAttachmentMethods.read, {
          attachmentId: committedInSub.id,
          variant: "full",
        }),
      ).toMatchObject({ error: { code: "RESOURCE_NOT_AVAILABLE" } })

      // 撤销配对：清理设备 A 正在进行的上传 + 遗留 staging 附件，但保留已提交会话附件。
      const committedByA = (
        (await uploadConcurrent(phoneA2, png, "image/png", "keep-me.png")).result as {
          attachment: ImageAttachmentRef
        }
      ).attachment
      await phoneA2.call("run.start", {
        commandId: randomUUID(),
        threadId: threadA.id,
        text: "retain",
        attachmentIds: [committedByA.id],
      })
      await expect.poll(() => vision.inputs.length).toBe(1)

      await phoneA2.call(mobileAttachmentMethods.uploadStart, {
        uploadId: "up_revoked",
        mimeType: "image/png",
        totalBytes: png.length,
        sha256: sha256Hex(png),
      })
      const store = new AttachmentStore(host.ctx.storage.db)
      const stagingRecord = store.get(stagingRef.id)!
      const stagingFilePath = join(host.ctx.attachments.dir, stagingRecord.storageName)
      expect(existsSync(stagingFilePath)).toBe(true)

      const savedA = host.devices.find(phoneA2.deviceKey)!
      host.devices.remove(savedA)
      revokeDeviceWork(host.ctx, phoneA2.deviceKey)

      // staging 附件已从 DB 和磁盘删除，已提交附件仍完好。
      expect(store.get(stagingRef.id)).toBeUndefined()
      expect(existsSync(stagingFilePath)).toBe(false)
      expect(store.get(committedByA.id)?.status).toBe("committed")
      expect(
        await phoneA2.call(mobileAttachmentMethods.uploadChunk, {
          uploadId: "up_revoked",
          offset: 0,
          dataBase64: png.toString("base64"),
        }),
      ).toMatchObject({ error: { code: "DEVICE_REVOKED" } })
    } finally {
      await host.dispose()
    }
  })

  it("supports queued messages with attachments, withdraw returning attachments, and legacy client isolation", async () => {
    const vision = createVisionDriver("vision-queue", true)
    const host = await setupHost({ extraDrivers: [vision.driver] })
    try {
      const project = host.ctx.projects.add("/tmp/pigcode-mobile-att-queue", "队列与兼容")
      const thread = host.ctx.threads.create(project.id, "队列会话", "vision-queue")
      const modern = host.connectDevice("新手机", 31, [
        "timeline.read",
        "run.write",
        "draft.write",
        "queue.write",
        "composer.controls",
        "composer.attachments",
      ])
      const legacyWithControls = host.connectDevice("旧手机含控件", 32, [
        "timeline.read",
        "run.write",
        "draft.write",
        "queue.write",
        "composer.controls",
      ])
      const legacyPlain = host.connectDevice("最旧手机", 33, ["run.write", "draft.write"])

      // 1. 待发队列带图入队与撤回返还 attachments。
      vision.block()
      await modern.call("run.start", {
        commandId: randomUUID(),
        threadId: thread.id,
        text: "first blocking",
      })
      await expect.poll(() => vision.inputs.length).toBe(1)

      const png1 = makePng(4096, 640, 480)
      const png2 = makePng(4096, 320, 240)
      const att1 = (
        (await uploadConcurrent(modern, png1, "image/png", "q1.png")).result as {
          attachment: ImageAttachmentRef
        }
      ).attachment
      const att2 = (
        (await uploadConcurrent(modern, png2, "image/png", "q2.png")).result as {
          attachment: ImageAttachmentRef
        }
      ).attachment

      const q1 = await modern.call("run.start", {
        commandId: randomUUID(),
        threadId: thread.id,
        text: "",
        attachmentIds: [att1.id],
      })
      const q1Id = (q1.result as { queuedMessageId: string }).queuedMessageId
      expect(q1Id).toBeTruthy()
      const q2 = await modern.call("run.start", {
        commandId: randomUUID(),
        threadId: thread.id,
        text: "queued with pic",
        attachmentIds: [att2.id],
      })
      const q2Id = (q2.result as { queuedMessageId: string }).queuedMessageId
      expect(q2Id).toBeTruthy()

      // 新客户端 queue.get 包含 attachments；旧客户端自动剥离 attachments 字段不破解析。
      const modernSnap = await modern.call("queue.get", { threadId: thread.id })
      expect(modernSnap.result).toMatchObject({
        messages: [
          { id: q1Id, text: "", attachments: [att1] },
          { id: q2Id, text: "queued with pic", attachments: [att2] },
        ],
      })
      const legacySnap = await legacyWithControls.call("queue.get", { threadId: thread.id })
      for (const msg of (legacySnap.result as { messages: Array<Record<string, unknown>> })
        .messages) {
        expect(msg).not.toHaveProperty("attachments")
      }

      // 撤回 q1，回执返回完整 attachments。
      const withdraw = await modern.call("queue.withdraw", {
        commandId: randomUUID(),
        threadId: thread.id,
        messageId: q1Id,
      })
      expect(withdraw.result).toMatchObject({
        effect: "withdrawn",
        messageId: q1Id,
        text: "",
        attachments: [att1],
      })

      // 放行阻塞运行后，q2 携带附件送达 Agent。
      vision.unblock()
      await expect.poll(() => vision.inputs.length).toBe(2)
      expect(vision.inputs[1]?.text).toBe("queued with pic")
      expect(vision.inputs[1]?.attachments?.[0]?.id).toBe(att2.id)

      // 2. 旧版客户端（未协商 composer.attachments）调用 mobile.attachment.* 返回 METHOD_NOT_AVAILABLE，
      //    且 run.start / thread.create 拒绝 attachmentIds 与空 text，原有文本发送不受影响。
      for (const legacy of [legacyWithControls, legacyPlain]) {
        expect(
          await legacy.call(mobileAttachmentMethods.uploadStart, {
            uploadId: "legacy_up",
            mimeType: "image/png",
            totalBytes: 100,
            sha256: "a".repeat(64),
          }),
        ).toMatchObject({ error: { code: "METHOD_NOT_AVAILABLE" } })
        expect(
          await legacy.call(mobileAttachmentMethods.read, {
            attachmentId: att2.id,
            variant: "full",
          }),
        ).toMatchObject({ error: { code: "METHOD_NOT_AVAILABLE" } })
        expect(
          await legacy.call("run.start", {
            commandId: randomUUID(),
            threadId: thread.id,
            text: "",
            attachmentIds: [att2.id],
          }),
        ).toMatchObject({ error: { code: "INVALID_PARAMS" } })
        expect(
          await legacy.call("run.start", {
            commandId: randomUUID(),
            threadId: thread.id,
            text: "hi",
            attachmentIds: [att2.id],
          }),
        ).toMatchObject({ error: { code: "INVALID_PARAMS" } })
        expect(
          await legacy.call("thread.create", {
            commandId: randomUUID(),
            projectId: project.id,
            instanceId: "vision-queue",
            permissionMode: "full-access",
            text: "",
            attachmentIds: [att2.id],
          }),
        ).toMatchObject({ error: { code: "INVALID_PARAMS" } })
      }

      // 旧客户端未协商 composer.attachments 时，draftOptions 与 timeline 不含 supportsImages / attachments。
      const legacyDraftOpts = await legacyWithControls.call("thread.draftOptions")
      for (const inst of (legacyDraftOpts.result as { instances: Array<Record<string, unknown>> })
        .instances) {
        expect(inst).not.toHaveProperty("supportsImages")
      }
      const legacySub = await legacyWithControls.call("thread.subscribe", { threadId: thread.id })
      expect((legacySub.result as { composer: Record<string, unknown> }).composer).not.toHaveProperty(
        "supportsImages",
      )
      for (const ev of (legacySub.result as { page: { events: Array<Record<string, unknown>> } })
        .page.events) {
        expect(ev).not.toHaveProperty("attachments")
      }

      // 旧客户端正常文本发送完全可用。
      const legacySend = await legacyPlain.call("run.start", {
        commandId: randomUUID(),
        threadId: thread.id,
        text: "旧版纯文本正常发送",
      })
      expect(legacySend.error).toBeUndefined()
      await expect.poll(() => vision.inputs.length).toBe(3)
      expect(vision.inputs[2]?.text).toBe("旧版纯文本正常发送")
    } finally {
      vision.unblock()
      await host.dispose()
    }
  })

  it("runs real Node Host + Dart pigcode_client end-to-end across upload, send, draft, thumb/full read, queue withdraw, and mid-flight cancel", async () => {
    const vision = createVisionDriver("dart-vision", true)
    const noVision = createVisionDriver("dart-plain", false)
    const fakeThumb = makeJpeg(16 * 1024, 360, 270)
    const host = await setupHost({
      thumbnailer: async () => fakeThumb,
      extraDrivers: [vision.driver, noVision.driver],
    })
    const project = host.ctx.projects.add("/tmp/pigcode-mobile-dart-e2e", "Dart 联调项目")
    const thread = host.ctx.threads.create(project.id, "新会话", "dart-vision")
    const phone = host.connectDevice("Dart 联调手机", 55, [
      "timeline.read",
      "run.write",
      "draft.write",
      "queue.write",
      "composer.controls",
      "composer.attachments",
    ])

    const clientPkgDir = fileURLToPath(
      new URL("../../../mobile/packages/pigcode_client", import.meta.url),
    )
    const dart = spawn("dart", ["run", "test/attachments_e2e_driver.dart"], {
      cwd: clientPkgDir,
      stdio: ["pipe", "pipe", "pipe"],
    })
    dart.stdin.on("error", () => {})
    let stderr = ""
    dart.stderr.setEncoding("utf8").on("data", (chunk: string) => {
      stderr += chunk
    })

    const cmdWaiters = new Map<
      string,
      (res: { ok: boolean; data?: Record<string, unknown>; error?: string; code?: string }) => void
    >()
    let maxOutboundFrameCount = 0
    let maxInboundFrameCount = 0

    // 转发 Host 通知与响应回 Dart，同时验证每一条协议帧都在 Noise 单帧上限内。
    phone.wire.client.onMessage((message) => {
      const record = message as { id?: string; method?: string; result?: unknown; error?: unknown }
      if (record.id) {
        const frames = [...mobileFrames(message)]
        if (frames.length > maxInboundFrameCount) maxInboundFrameCount = frames.length
        dart.stdin.write(
          JSON.stringify({
            dir: "rpc_res",
            id: record.id,
            ...(record.error !== undefined ? { error: record.error } : { result: record.result }),
          }) + "\n",
        )
      } else if (record.method) {
        dart.stdin.write(JSON.stringify({ dir: "rpc_notify", message }) + "\n")
      }
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
        if (frames.length > maxOutboundFrameCount) maxOutboundFrameCount = frames.length
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

    function dartCmd(action: string, args: Record<string, unknown> = {}) {
      const cmdId = randomUUID()
      return new Promise<{
        ok: boolean
        data?: Record<string, unknown>
        error?: string
        code?: string
      }>((resolve, reject) => {
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

    try {
      // 1. Dart 4 路并发上传 > 100 KiB 真实 PNG。
      const largePng = makePng(135 * 1024, 1920, 1080)
      const uploaded = await dartCmd("upload", {
        dataBase64: largePng.toString("base64"),
        mimeType: "image/png",
        fileName: "dart-shot.png",
        width: 1920,
        height: 1080,
      })
      expect(uploaded.ok, uploaded.error).toBe(true)
      const att = uploaded.data!.attachment as ImageAttachmentRef
      expect(att).toMatchObject({
        id: expect.stringMatching(/^att_/),
        mimeType: "image/png",
        fileName: "dart-shot.png",
        sizeBytes: largePng.length,
        width: 1920,
        height: 1080,
      })
      const uploadProgress = uploaded.data!.progress as Array<{
        uploadedBytes: number
        totalBytes: number
      }>
      expect(uploadProgress.length).toBe(Math.ceil(largePng.length / MOBILE_ATTACHMENT_CHUNK_BYTES))
      expect(uploadProgress.at(-1)).toEqual({
        uploadedBytes: largePng.length,
        totalBytes: largePng.length,
      })

      // 2. Dart 发送纯图空文本 run.start 与幂等重试。
      const startCmdId = randomUUID()
      const runParams = {
        commandId: startCmdId,
        threadId: thread.id,
        text: "",
        attachmentIds: [att.id],
      }
      const started = await dartCmd("startRun", { params: runParams })
      expect(started.ok, started.error).toBe(true)
      const retried = await dartCmd("startRun", { params: runParams })
      expect(retried.ok, retried.error).toBe(true)
      expect(retried.data!.receipt).toEqual(started.data!.receipt)
      await expect.poll(() => vision.inputs.length).toBe(1)
      expect(vision.inputs[0]?.attachments?.[0]?.id).toBe(att.id)

      // 3. Dart 打开 MobileTimeline 验证 message.user.attachments、timelineTurns 与 composer.supportsImages。
      const timeline = await dartCmd("openTimeline", { threadId: thread.id })
      expect(timeline.ok, timeline.error).toBe(true)
      expect(timeline.data!.composerSupportsImages).toBe(true)
      expect(timeline.data!.turns).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            userText: "",
            userAttachments: [att],
          }),
        ]),
      )

      // 4. Dart 读取 thumb 与分片读取 full，验证 100% 字节一致。
      const thumbRes = await dartCmd("readThumb", { attachmentId: att.id, threadId: thread.id })
      expect(thumbRes.ok, thumbRes.error).toBe(true)
      expect(thumbRes.data!.mimeType).toBe("image/jpeg")
      expect(Buffer.from(thumbRes.data!.dataBase64 as string, "base64").equals(fakeThumb)).toBe(
        true,
      )

      const fullRes = await dartCmd("readFull", { attachmentId: att.id, threadId: thread.id })
      expect(fullRes.ok, fullRes.error).toBe(true)
      expect(fullRes.data!.mimeType).toBe("image/png")
      expect(Buffer.from(fullRes.data!.dataBase64 as string, "base64").equals(largePng)).toBe(true)
      const readProgress = fullRes.data!.progress as Array<[number, number]>
      expect(readProgress.length).toBe(Math.ceil(largePng.length / MOBILE_ATTACHMENT_CHUNK_BYTES))
      expect(readProgress.at(-1)).toEqual([largePng.length, largePng.length])

      // 5. Dart 查询 draftOptions.supportsImages 并创建带图草稿线程。
      const optsRes = await dartCmd("draftOptions")
      expect(optsRes.ok, optsRes.error).toBe(true)
      expect(optsRes.data!.supportsImages).toMatchObject({
        "dart-vision": true,
        "dart-plain": false,
      })

      const draftPng = makePng(48 * 1024, 800, 600)
      const draftUp = await dartCmd("upload", {
        dataBase64: draftPng.toString("base64"),
        mimeType: "image/png",
        fileName: "draft.png",
      })
      const draftAtt = draftUp.data!.attachment as ImageAttachmentRef
      const draftCreated = await dartCmd("createDraft", {
        params: {
          commandId: randomUUID(),
          projectId: project.id,
          instanceId: "dart-vision",
          permissionMode: "full-access",
          text: "",
          attachmentIds: [draftAtt.id],
        },
      })
      expect(draftCreated.ok, draftCreated.error).toBe(true)
      await expect.poll(() => vision.inputs.length).toBe(2)

      // 6. Dart 待发消息带图入队与撤回返还 attachments。
      await expect.poll(() => host.ctx.agents.listRuns()).toEqual([])
      vision.block()
      await dartCmd("startRun", {
        params: { commandId: randomUUID(), threadId: thread.id, text: "hold" },
      })
      await expect.poll(() => vision.inputs.length).toBe(3)

      const queuedUp = await dartCmd("upload", {
        dataBase64: makePng(12 * 1024).toString("base64"),
        mimeType: "image/png",
        fileName: "queued.png",
      })
      const queuedAtt = queuedUp.data!.attachment as ImageAttachmentRef
      const queuedRun = await dartCmd("startRun", {
        params: {
          commandId: randomUUID(),
          threadId: thread.id,
          text: "",
          attachmentIds: [queuedAtt.id],
        },
      })
      const queuedMsgId = (queuedRun.data!.receipt as { queuedMessageId: string }).queuedMessageId
      const snapRes = await dartCmd("queueSnapshot", { threadId: thread.id })
      expect(snapRes.ok, snapRes.error).toBe(true)
      expect(snapRes.data!.snapshot).toMatchObject({
        messages: [{ id: queuedMsgId, text: "", attachments: [queuedAtt] }],
      })
      const withdrawRes = await dartCmd("queueWithdraw", {
        threadId: thread.id,
        commandId: randomUUID(),
        messageId: queuedMsgId,
      })
      expect(withdrawRes.ok, withdrawRes.error).toBe(true)
      expect(withdrawRes.data!.receipt).toMatchObject({
        effect: "withdrawn",
        attachments: [queuedAtt],
      })
      vision.unblock()
      await expect.poll(() => host.ctx.agents.listRuns()).toEqual([])

      // 7. Dart 途中取消上传触发 uploadCancel 并释放服务端缓冲。
      const cancelRes = await dartCmd("upload", {
        dataBase64: makePng(256 * 1024).toString("base64"),
        mimeType: "image/png",
        fileName: "cancel-me.png",
        cancelAfterChunks: 1,
      })
      expect(cancelRes.ok).toBe(false)
      expect(cancelRes.code).toBe("UPLOAD_CANCELLED")

      // 所有双向附件 RPC 均未超出 Go 中继 65,535 字节单帧限制。
      expect(maxOutboundFrameCount).toBe(1)
      expect(maxInboundFrameCount).toBe(1)
    } finally {
      vision.unblock()
      if (!dart.stdin.destroyed && dart.exitCode === null) {
        dart.stdin.write(JSON.stringify({ dir: "exit" }) + "\n")
        dart.stdin.end()
      }
      rl.close()
      dart.kill()
      await host.dispose()
    }
  }, 30_000)
})
