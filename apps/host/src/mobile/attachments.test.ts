import { randomUUID } from "node:crypto"
import {
  MOBILE_ATTACHMENT_CHUNK_BYTES,
  MOBILE_THUMBNAIL_MAX_BYTES,
  mobileAttachmentMethods,
  mobileFeatures,
  type ImageAttachmentRef,
} from "@pigcode/contracts"
import { describe, expect, it } from "vitest"
import {
  createVisionDriver,
  makeJpeg,
  makePng,
  readAllChunks,
  setupAttachmentHost,
  uploadConcurrent,
} from "./attachments.test-helpers"

describe("mobile composer.attachments protocol & Host implementation", () => {
  it("uploads >100 KiB PNG/JPEG concurrently out-of-order, sends image-only runs & drafts with idempotency, and reads thumb/full byte-identically", async () => {
    expect(mobileFeatures).toContain("composer.attachments")
    const vision = createVisionDriver("vision-agent", true)
    const noVision = createVisionDriver("text-only-agent", false)
    const fakeThumb = makeJpeg(14 * 1024, 360, 202)
    const host = await setupAttachmentHost({
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
        .find(
          (e) => e.type === "message.completed" && (e.payload as { role?: string }).role === "user",
        )
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
    const host = await setupAttachmentHost()
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

  it("supports queued messages with attachments, withdraw returning attachments, and legacy client isolation", async () => {
    const vision = createVisionDriver("vision-queue", true)
    const host = await setupAttachmentHost({ extraDrivers: [vision.driver] })
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
      expect(
        (legacySub.result as { composer: Record<string, unknown> }).composer,
      ).not.toHaveProperty("supportsImages")
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
})
