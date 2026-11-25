import { EventEmitter } from "node:events"
import type { MessagePortMain } from "electron"
import { describe, expect, it, vi } from "vitest"
import { attachAttachmentThumbnails, generateThumbnail } from "./attachment-thumbnail"

interface FakeImage {
  width: number
  height: number
  empty?: boolean
  isEmpty: () => boolean
  getSize: () => { width: number; height: number }
  resize: (opts: { width?: number; height?: number }) => FakeImage
  toJPEG: (quality: number) => Buffer
}

function makeFakeImage(width: number, height: number, empty = false): FakeImage {
  const img: FakeImage = {
    width,
    height,
    empty,
    isEmpty: () => empty,
    getSize: () => ({ width: img.width, height: img.height }),
    resize: ({ width: nextW, height: nextH }) => {
      if (nextW && !nextH) {
        return makeFakeImage(nextW, Math.max(1, Math.round((height * nextW) / width)))
      }
      if (nextH && !nextW) {
        return makeFakeImage(Math.max(1, Math.round((width * nextH) / height)), nextH)
      }
      return makeFakeImage(nextW ?? width, nextH ?? height)
    },
    toJPEG: (quality) => Buffer.alloc(Math.max(100, Math.round((img.width * img.height * quality) / 200)), 0xaa),
  }
  return img
}

const mockCreateFromBuffer = vi.fn((buf: Buffer) => {
  if (buf.length === 0) return makeFakeImage(0, 0, true)
  const w = buf.readUInt16BE(0)
  const h = buf.readUInt16BE(2)
  return makeFakeImage(w, h)
})

vi.mock("electron", () => ({
  nativeImage: {
    createFromBuffer: (buf: Buffer) => mockCreateFromBuffer(buf),
  },
}))

function dimsBuf(width: number, height: number): Buffer {
  const buf = Buffer.alloc(4)
  buf.writeUInt16BE(width, 0)
  buf.writeUInt16BE(height, 2)
  return buf
}

describe("desktop attachment thumbnail bridge", () => {
  it("resizes long edge to maxEdge and steps JPEG quality down until within maxBytes", () => {
    const out = generateThumbnail(dimsBuf(1600, 800), 360, 20_000)
    expect(out).not.toBeNull()
    expect(out!.length).toBeLessThanOrEqual(20_000)
    expect(out!.length).toBeGreaterThan(0)

    // Portrait image scales by height
    const portrait = generateThumbnail(dimsBuf(800, 1600), 360, 20_000)
    expect(portrait).not.toBeNull()
    expect(portrait!.length).toBeLessThanOrEqual(20_000)

    // Empty / undecodable buffer returns null
    expect(generateThumbnail(Buffer.alloc(0), 360, 40_960)).toBeNull()
  })

  it("responds to attachment.thumbnail requests on the Host controlPort", () => {
    const port = Object.assign(new EventEmitter(), { start: vi.fn(), postMessage: vi.fn() })
    attachAttachmentThumbnails(port as unknown as MessagePortMain)
    expect(port.start).toHaveBeenCalledOnce()

    port.emit("message", {
      data: {
        type: "attachment.thumbnail",
        id: "req_1",
        dataBase64: dimsBuf(1200, 900).toString("base64"),
        maxEdge: 360,
        maxBytes: 40_960,
      },
    })
    const reply = port.postMessage.mock.lastCall?.[0] as {
      type: string
      id: string
      dataBase64: string | null
    }
    expect(reply).toMatchObject({ type: "attachment.thumbnail.result", id: "req_1" })
    expect(reply.dataBase64).toEqual(expect.any(String))
    expect(Buffer.from(reply.dataBase64!, "base64").length).toBeLessThanOrEqual(40_960)
  })
})
