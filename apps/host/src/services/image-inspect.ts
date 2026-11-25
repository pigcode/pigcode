/** 纯 TypeScript 图片魔数与尺寸解析；仅放行真实 PNG/JPEG/WebP/GIF，拒绝 SVG/HTML 等非图片内容。 */
import type { ImageAttachmentMimeType } from "@pigcode/contracts"

export interface InspectedImage {
  mimeType: ImageAttachmentMimeType
  ext: "png" | "jpg" | "webp" | "gif"
  width?: number
  height?: number
}

const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

/** 按文件头魔数严格识别图片格式并解析宽高；无法识别或头截断时返回 null。 */
export function inspectImageBuffer(input: Buffer | Uint8Array): InspectedImage | null {
  const buf = Buffer.isBuffer(input) ? input : Buffer.from(input.buffer, input.byteOffset, input.byteLength)
  if (buf.length === 0) return null
  return inspectPng(buf) ?? inspectJpeg(buf) ?? inspectGif(buf) ?? inspectWebp(buf)
}

function inspectPng(buf: Buffer): InspectedImage | null {
  if (buf.length < 24) return null
  if (!buf.subarray(0, 8).equals(PNG_MAGIC)) return null
  const ihdrLength = buf.readUInt32BE(8)
  if (ihdrLength < 13 || buf.toString("ascii", 12, 16) !== "IHDR") return null
  const width = buf.readUInt32BE(16)
  const height = buf.readUInt32BE(20)
  if (width === 0 || height === 0) return null
  return { mimeType: "image/png", ext: "png", width, height }
}

function inspectGif(buf: Buffer): InspectedImage | null {
  if (buf.length < 10) return null
  const header = buf.toString("ascii", 0, 6)
  if (header !== "GIF87a" && header !== "GIF89a") return null
  const width = buf.readUInt16LE(6)
  const height = buf.readUInt16LE(8)
  if (width === 0 || height === 0) return null
  return { mimeType: "image/gif", ext: "gif", width, height }
}

const JPEG_SOF_MARKERS = new Set([0xc0, 0xc1, 0xc2, 0xc3])

function inspectJpeg(buf: Buffer): InspectedImage | null {
  if (buf.length < 4 || buf[0] !== 0xff || buf[1] !== 0xd8 || buf[2] !== 0xff) return null
  let offset = 2
  while (offset < buf.length) {
    if (buf[offset] !== 0xff) return null
    while (offset < buf.length && buf[offset] === 0xff) offset += 1
    if (offset >= buf.length) return null
    const marker = buf[offset]!
    offset += 1
    if (marker === 0x00) return null
    // 独立标记没有长度字段。
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue
    if (marker === 0xd9 || marker === 0xda) return null
    if (offset + 2 > buf.length) return null
    const segmentLength = buf.readUInt16BE(offset)
    if (segmentLength < 2 || offset + segmentLength > buf.length) return null
    if (JPEG_SOF_MARKERS.has(marker)) {
      if (segmentLength < 7) return null
      const height = buf.readUInt16BE(offset + 3)
      const width = buf.readUInt16BE(offset + 5)
      if (width === 0 || height === 0) return null
      return { mimeType: "image/jpeg", ext: "jpg", width, height }
    }
    offset += segmentLength
  }
  return null
}

function inspectWebp(buf: Buffer): InspectedImage | null {
  if (buf.length < 16) return null
  if (buf.toString("ascii", 0, 4) !== "RIFF" || buf.toString("ascii", 8, 12) !== "WEBP") return null
  const chunk = buf.toString("ascii", 12, 16)
  if (chunk === "VP8 ") {
    if (buf.length < 30) return null
    if (buf[23] !== 0x9d || buf[24] !== 0x01 || buf[25] !== 0x2a) return null
    const width = buf.readUInt16LE(26) & 0x3fff
    const height = buf.readUInt16LE(28) & 0x3fff
    if (width === 0 || height === 0) return null
    return { mimeType: "image/webp", ext: "webp", width, height }
  }
  if (chunk === "VP8L") {
    if (buf.length < 25 || buf[20] !== 0x2f) return null
    const bits = buf.readUInt32LE(21)
    const width = (bits & 0x3fff) + 1
    const height = ((bits >>> 14) & 0x3fff) + 1
    return { mimeType: "image/webp", ext: "webp", width, height }
  }
  if (chunk === "VP8X") {
    if (buf.length < 30) return null
    const width = (buf[24]! | (buf[25]! << 8) | (buf[26]! << 16)) + 1
    const height = (buf[27]! | (buf[28]! << 8) | (buf[29]! << 16)) + 1
    return { mimeType: "image/webp", ext: "webp", width, height }
  }
  return null
}
