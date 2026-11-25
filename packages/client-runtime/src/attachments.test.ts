/** 验证 client-runtime 的图片上传、按 variant 缓存读取、并发去重及 startRun 携带 attachmentIds。 */
import { describe, expect, it } from "vitest"
import type { ImageAttachmentRef } from "@pigcode/contracts"
import { MemoryTransport } from "../../../apps/host/src/rpc/memory-transport"
import { AttachmentReadCache, toAttachmentDataUrl } from "./attachments"
import { Connection } from "./connection"

interface HostRequest {
  id: string
  method: string
  params: Record<string, unknown>
}

const sampleRef: ImageAttachmentRef = {
  id: "att_01",
  mimeType: "image/png",
  fileName: "bug.png",
  sizeBytes: 1234,
  width: 640,
  height: 480,
}

function createConnected() {
  const transport = new MemoryTransport()
  const connection = new Connection({
    onEvent: () => {},
    onDelta: () => {},
    onStatus: () => {},
  })
  return { transport, connection }
}

describe("Connection attachments", () => {
  it("uploads an image attachment via attachment.upload and validates the response", async () => {
    const { transport, connection } = createConnected()
    await connection.attach(transport.client)

    const pending = connection.uploadAttachment({
      dataBase64: "iVBORw0KGgo=",
      fileName: "bug.png",
      mimeType: "image/png",
      threadId: "th_1",
    })
    const req = (await transport.host.next()) as HostRequest
    expect(req.method).toBe("attachment.upload")
    expect(req.params).toEqual({
      dataBase64: "iVBORw0KGgo=",
      fileName: "bug.png",
      mimeType: "image/png",
      threadId: "th_1",
    })
    transport.host.send({ jsonrpc: "2.0", id: req.id, result: { attachment: sampleRef } })

    await expect(pending).resolves.toEqual(sampleRef)
  })

  it("reads attachments with per-variant memory caching and deduplicates concurrent reads", async () => {
    const { transport, connection } = createConnected()
    await connection.attach(transport.client)

    const first = connection.readAttachment({
      attachmentId: "att_01",
      threadId: "th_1",
      variant: "thumb",
    })
    const concurrent = connection.readAttachmentDataUrl({
      attachmentId: "att_01",
      threadId: "th_1",
      variant: "thumb",
    })

    const thumbReq = (await transport.host.next()) as HostRequest
    expect(thumbReq.method).toBe("attachment.read")
    expect(thumbReq.params).toEqual({
      attachmentId: "att_01",
      threadId: "th_1",
      variant: "thumb",
    })
    transport.host.send({
      jsonrpc: "2.0",
      id: thumbReq.id,
      result: { attachment: sampleRef, mimeType: "image/jpeg", dataBase64: "dGh1bWI=" },
    })

    const [readResult, dataUrl] = await Promise.all([first, concurrent])
    expect(readResult).toEqual({
      attachment: sampleRef,
      mimeType: "image/jpeg",
      dataBase64: "dGh1bWI=",
    })
    expect(dataUrl).toBe(toAttachmentDataUrl("image/jpeg", "dGh1bWI="))
    expect(
      connection.peekAttachmentDataUrl({
        attachmentId: "att_01",
        threadId: "th_1",
        variant: "thumb",
      }),
    ).toBe("data:image/jpeg;base64,dGh1bWI=")

    // 再次读取同一 thumb 命中缓存，不会再发出 RPC 请求。
    const cached = await connection.readAttachment({
      attachmentId: "att_01",
      threadId: "th_1",
      variant: "thumb",
    })
    expect(cached.dataBase64).toBe("dGh1bWI=")

    // 读取 full 变体会发起独立的 RPC 请求并分别缓存。
    const fullPending = connection.readAttachment({
      attachmentId: "att_01",
      threadId: "th_1",
      variant: "full",
    })
    const fullReq = (await transport.host.next()) as HostRequest
    expect(fullReq.method).toBe("attachment.read")
    expect(fullReq.params).toEqual({
      attachmentId: "att_01",
      threadId: "th_1",
      variant: "full",
    })
    transport.host.send({
      jsonrpc: "2.0",
      id: fullReq.id,
      result: { attachment: sampleRef, mimeType: "image/png", dataBase64: "ZnVsbA==" },
    })
    const fullResult = await fullPending
    expect(fullResult.dataBase64).toBe("ZnVsbA==")
  })

  it("evicts failed reads so subsequent attempts can retry", async () => {
    const { transport, connection } = createConnected()
    await connection.attach(transport.client)

    const failed = connection.readAttachment({
      attachmentId: "att_01",
      variant: "full",
    })
    const req1 = (await transport.host.next()) as HostRequest
    transport.host.send({
      jsonrpc: "2.0",
      id: req1.id,
      error: { code: "ATTACHMENT_NOT_FOUND", message: "missing" },
    })
    await expect(failed).rejects.toThrow("missing")

    const retry = connection.readAttachment({
      attachmentId: "att_01",
      variant: "full",
    })
    const req2 = (await transport.host.next()) as HostRequest
    transport.host.send({
      jsonrpc: "2.0",
      id: req2.id,
      result: { attachment: sampleRef, mimeType: "image/png", dataBase64: "b2s=" },
    })
    await expect(retry).resolves.toMatchObject({ dataBase64: "b2s=" })
  })

  it("forwards attachmentIds through startRun and supports image-only messages", async () => {
    const { transport, connection } = createConnected()
    await connection.attach(transport.client)

    const pending = connection.startRun("th_1", "", {
      attachmentIds: ["att_01", "att_02"],
      effort: "medium",
    })
    const req = (await transport.host.next()) as HostRequest
    expect(req.method).toBe("run.start")
    expect(req.params).toEqual({
      threadId: "th_1",
      text: "",
      effort: "medium",
      attachmentIds: ["att_01", "att_02"],
    })
    transport.host.send({ jsonrpc: "2.0", id: req.id, result: { runId: "run_1" } })
    await pending
  })
})

describe("AttachmentReadCache", () => {
  it("evicts least recently used entries beyond maxEntries", async () => {
    const cache = new AttachmentReadCache(2)
    const make = (id: string) => ({
      attachment: { ...sampleRef, id },
      mimeType: "image/png" as const,
      dataBase64: id,
    })

    await cache.load({ attachmentId: "a", variant: "thumb" }, async () => make("a"))
    await cache.load({ attachmentId: "b", variant: "thumb" }, async () => make("b"))
    // 访问 a 使其成为最近使用
    expect(cache.peekDataUrl({ attachmentId: "a", variant: "thumb" })).toBe("data:image/png;base64,a")
    await cache.load({ attachmentId: "c", variant: "thumb" }, async () => make("c"))

    expect(cache.peekDataUrl({ attachmentId: "a", variant: "thumb" })).toBeDefined()
    expect(cache.peekDataUrl({ attachmentId: "b", variant: "thumb" })).toBeUndefined()
    expect(cache.peekDataUrl({ attachmentId: "c", variant: "thumb" })).toBeDefined()
  })
})
