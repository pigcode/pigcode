// An encrypted WebSocket frame can carry 65,535 bytes including the Noise tag.
export const MAX_NOISE_PLAINTEXT = 65535 - 16
const HEADER_BYTES = 9
export const MOBILE_MAX_MESSAGE_BYTES = 256 * 1024 + 1024

/** Large RPC messages use ordered, authenticated fragments. Small messages keep the v1 JSON frame. */
export function* mobileFrames(
  message: unknown,
  maxBytes: number = MOBILE_MAX_MESSAGE_BYTES,
): Iterable<Buffer> {
  const bytes = Buffer.from(JSON.stringify(message))
  if (bytes.length <= MAX_NOISE_PLAINTEXT) {
    yield bytes
    return
  }
  if (bytes.length > maxBytes) throw new Error("Oversized framed message")
  for (let offset = 0; offset < bytes.length; offset += MAX_NOISE_PLAINTEXT - HEADER_BYTES) {
    const data = bytes.subarray(offset, offset + MAX_NOISE_PLAINTEXT - HEADER_BYTES)
    const frame = Buffer.alloc(HEADER_BYTES + data.length)
    frame.writeUInt32BE(bytes.length, 1)
    frame.writeUInt32BE(offset, 5)
    data.copy(frame, HEADER_BYTES)
    yield frame
  }
}

export type FrameAssembleResult = { complete: false } | { complete: true; message: unknown }

/** 将单帧或 9 字节头分片的明文 JSON 报文重组并反序列化。 */
export class FrameAssembler {
  private total = 0
  private received = 0
  private chunks: Buffer[] = []

  constructor(private readonly maxBytes: number = MOBILE_MAX_MESSAGE_BYTES) {}

  reset(): void {
    this.total = 0
    this.received = 0
    this.chunks = []
  }

  push(plain: Buffer): FrameAssembleResult {
    if (plain.length === 0) throw new Error("empty framed message")
    if (plain[0] !== 0x00) {
      if (this.chunks.length > 0) throw new Error("unexpected unfragmented frame during assembly")
      if (plain.length > this.maxBytes) throw new Error("oversized framed message")
      return { complete: true, message: JSON.parse(plain.toString("utf8")) as unknown }
    }
    if (plain.length <= HEADER_BYTES) throw new Error("truncated fragment header")
    const totalLength = plain.readUInt32BE(1)
    const offset = plain.readUInt32BE(5)
    const data = plain.subarray(HEADER_BYTES)
    if (totalLength === 0 || totalLength > this.maxBytes || data.length === 0) {
      this.reset()
      throw new Error("invalid fragment bounds")
    }
    if (offset !== this.received || offset + data.length > totalLength) {
      this.reset()
      throw new Error("out-of-order fragment offset")
    }
    if (this.chunks.length === 0) {
      if (offset !== 0) {
        this.reset()
        throw new Error("missing initial fragment")
      }
      this.total = totalLength
    } else if (totalLength !== this.total) {
      this.reset()
      throw new Error("mismatched fragment total length")
    }
    this.chunks.push(Buffer.from(data))
    this.received += data.length
    if (this.received < this.total) return { complete: false }
    const full = Buffer.concat(this.chunks, this.total)
    this.reset()
    return { complete: true, message: JSON.parse(full.toString("utf8")) as unknown }
  }
}
