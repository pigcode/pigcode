// An encrypted WebSocket frame can carry 65,535 bytes including the Noise tag.
const maxPlaintext = 65535 - 16
const header = 9
const maxMessage = 256 * 1024 + 1024

/** Large RPC messages use ordered, authenticated fragments. Small messages keep the v1 JSON frame. */
export function* mobileFrames(message: unknown): Iterable<Buffer> {
  const bytes = Buffer.from(JSON.stringify(message))
  if (bytes.length <= maxPlaintext) {
    yield bytes
    return
  }
  if (bytes.length > maxMessage) throw new Error("Oversized mobile message")
  for (let offset = 0; offset < bytes.length; offset += maxPlaintext - header) {
    const data = bytes.subarray(offset, offset + maxPlaintext - header)
    const frame = Buffer.alloc(header + data.length)
    frame.writeUInt32BE(bytes.length, 1)
    frame.writeUInt32BE(offset, 5)
    data.copy(frame, header)
    yield frame
  }
}
