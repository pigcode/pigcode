import { spawn } from "node:child_process"
import { randomUUID } from "node:crypto"
import { createInterface } from "node:readline"
import { fileURLToPath } from "node:url"
import { MOBILE_ATTACHMENT_CHUNK_BYTES, type ImageAttachmentRef } from "@pigcode/contracts"
import { describe, expect, it } from "vitest"
import {
  createVisionDriver,
  makeJpeg,
  makePng,
  setupAttachmentHost,
} from "./attachments.test-helpers"
import { mobileFrames } from "./mobile-frames"

describe("mobile composer.attachments Dart client end-to-end", () => {
  it("runs real Node Host + Dart pigcode_client end-to-end across upload, send, draft, thumb/full read, queue withdraw, and mid-flight cancel", async () => {
    const vision = createVisionDriver("dart-vision", true)
    const noVision = createVisionDriver("dart-plain", false)
    const fakeThumb = makeJpeg(16 * 1024, 360, 270)
    const host = await setupAttachmentHost({
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
