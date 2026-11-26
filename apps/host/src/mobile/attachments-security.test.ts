import { randomUUID } from "node:crypto"
import { existsSync } from "node:fs"
import { join } from "node:path"
import {
  MOBILE_MAX_IMAGE_BYTES,
  mobileAttachmentMethods,
  type ImageAttachmentRef,
} from "@pigcode/contracts"
import { describe, expect, it } from "vitest"
import { AttachmentStore } from "../storage/attachment-store"
import { MOBILE_MAX_CONCURRENT_UPLOADS, MobileAttachments } from "./attachments"
import {
  createVisionDriver,
  makePng,
  setupAttachmentHost,
  sha256Hex,
  uploadConcurrent,
} from "./attachments.test-helpers"
import { revokeDeviceWork } from "./revocation"

describe("mobile composer.attachments security, quotas & isolation", () => {
  it("rejects cancel/hash mismatch/spoofed SVG/bad magic/oversized/duplicate/overlapping/incomplete uploads and enforces device quotas", async () => {
    const host = await setupAttachmentHost()
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
    const host = await setupAttachmentHost({ extraDrivers: [vision.driver] })
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
})
