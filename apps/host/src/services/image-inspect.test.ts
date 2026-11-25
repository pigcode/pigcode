import { describe, expect, it } from "vitest"
import { inspectImageBuffer } from "./image-inspect"

function makePng(width: number, height: number): Buffer {
  const buf = Buffer.alloc(33)
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(buf, 0)
  buf.writeUInt32BE(13, 8)
  buf.write("IHDR", 12, "ascii")
  buf.writeUInt32BE(width, 16)
  buf.writeUInt32BE(height, 20)
  return buf
}

function makeJpeg(width: number, height: number, sofMarker = 0xc0): Buffer {
  const app0 = Buffer.from([0xff, 0xe0, 0x00, 0x06, 0x4a, 0x46, 0x49, 0x46])
  const sof = Buffer.alloc(11)
  sof[0] = 0xff
  sof[1] = sofMarker
  sof.writeUInt16BE(9, 2)
  sof[4] = 8
  sof.writeUInt16BE(height, 5)
  sof.writeUInt16BE(width, 7)
  sof[9] = 3
  return Buffer.concat([Buffer.from([0xff, 0xd8]), app0, sof, Buffer.from([0xff, 0xd9])])
}

function makeGif(width: number, height: number, version: "GIF87a" | "GIF89a" = "GIF89a"): Buffer {
  const buf = Buffer.alloc(14)
  buf.write(version, 0, "ascii")
  buf.writeUInt16LE(width, 6)
  buf.writeUInt16LE(height, 8)
  return buf
}

function makeWebpVp8(width: number, height: number): Buffer {
  const buf = Buffer.alloc(30)
  buf.write("RIFF", 0, "ascii")
  buf.writeUInt32LE(22, 4)
  buf.write("WEBP", 8, "ascii")
  buf.write("VP8 ", 12, "ascii")
  buf.writeUInt32LE(10, 16)
  buf[23] = 0x9d
  buf[24] = 0x01
  buf[25] = 0x2a
  buf.writeUInt16LE(width & 0x3fff, 26)
  buf.writeUInt16LE(height & 0x3fff, 28)
  return buf
}

function makeWebpVp8l(width: number, height: number): Buffer {
  const buf = Buffer.alloc(25)
  buf.write("RIFF", 0, "ascii")
  buf.writeUInt32LE(17, 4)
  buf.write("WEBP", 8, "ascii")
  buf.write("VP8L", 12, "ascii")
  buf.writeUInt32LE(5, 16)
  buf[20] = 0x2f
  const bits = ((width - 1) & 0x3fff) | (((height - 1) & 0x3fff) << 14)
  buf.writeUInt32LE(bits >>> 0, 21)
  return buf
}

function makeWebpVp8x(width: number, height: number): Buffer {
  const buf = Buffer.alloc(30)
  buf.write("RIFF", 0, "ascii")
  buf.writeUInt32LE(22, 4)
  buf.write("WEBP", 8, "ascii")
  buf.write("VP8X", 12, "ascii")
  buf.writeUInt32LE(10, 16)
  const w = width - 1
  const h = height - 1
  buf[24] = w & 0xff
  buf[25] = (w >> 8) & 0xff
  buf[26] = (w >> 16) & 0xff
  buf[27] = h & 0xff
  buf[28] = (h >> 8) & 0xff
  buf[29] = (h >> 16) & 0xff
  return buf
}

describe("inspectImageBuffer", () => {
  it("detects PNG, JPEG, GIF, and WebP formats and dimensions", () => {
    expect(inspectImageBuffer(makePng(1170, 2532))).toEqual({
      mimeType: "image/png",
      ext: "png",
      width: 1170,
      height: 2532,
    })
    expect(inspectImageBuffer(makeJpeg(1920, 1080, 0xc0))).toEqual({
      mimeType: "image/jpeg",
      ext: "jpg",
      width: 1920,
      height: 1080,
    })
    expect(inspectImageBuffer(makeJpeg(640, 480, 0xc2))).toEqual({
      mimeType: "image/jpeg",
      ext: "jpg",
      width: 640,
      height: 480,
    })
    expect(inspectImageBuffer(makeGif(320, 240, "GIF87a"))).toEqual({
      mimeType: "image/gif",
      ext: "gif",
      width: 320,
      height: 240,
    })
    expect(inspectImageBuffer(makeGif(800, 600, "GIF89a"))).toEqual({
      mimeType: "image/gif",
      ext: "gif",
      width: 800,
      height: 600,
    })
    expect(inspectImageBuffer(makeWebpVp8(1024, 768))).toEqual({
      mimeType: "image/webp",
      ext: "webp",
      width: 1024,
      height: 768,
    })
    expect(inspectImageBuffer(makeWebpVp8l(512, 256))).toEqual({
      mimeType: "image/webp",
      ext: "webp",
      width: 512,
      height: 256,
    })
    expect(inspectImageBuffer(makeWebpVp8x(2048, 1536))).toEqual({
      mimeType: "image/webp",
      ext: "webp",
      width: 2048,
      height: 1536,
    })
  })

  it("rejects SVG, HTML, plain text, empty buffers, and truncated headers", () => {
    expect(inspectImageBuffer(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"></svg>'))).toBeNull()
    expect(inspectImageBuffer(Buffer.from("<!doctype html><html><body>hi</body></html>"))).toBeNull()
    expect(inspectImageBuffer(Buffer.from("plain text file"))).toBeNull()
    expect(inspectImageBuffer(Buffer.alloc(0))).toBeNull()
    expect(inspectImageBuffer(makePng(100, 100).subarray(0, 16))).toBeNull()
    expect(inspectImageBuffer(makePng(0, 100))).toBeNull()
    expect(inspectImageBuffer(Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00]))).toBeNull()
    expect(inspectImageBuffer(Buffer.from("GIF89a\x01"))).toBeNull()
    expect(inspectImageBuffer(Buffer.from("RIFF\x10\x00\x00\x00WEBPVP8 "))).toBeNull()
  })
})
