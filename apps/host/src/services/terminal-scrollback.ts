/** 终端有界环形回滚缓冲：按 UTF-8 字节上限淘汰旧分片，并确保不切裂 UTF-16 代理对。 */

/** 每个终端默认保留的最大输出回滚字节数（UTF-8，256 KiB）。 */
export const DEFAULT_SCROLLBACK_BYTES = 256 * 1024

/** 回滚缓冲中的单个输出分片。 */
interface ScrollbackChunk {
  start: number
  data: string
  bytes: number
}

/** 规范化配置的回滚字节上限。 */
export function normalizeScrollbackBytes(value: number | undefined): number {
  if (value === undefined) return DEFAULT_SCROLLBACK_BYTES
  return Number.isFinite(value) ? Math.max(0, Math.floor(value)) : DEFAULT_SCROLLBACK_BYTES
}

function isHighSurrogate(code: number): boolean {
  return code >= 0xd800 && code <= 0xdbff
}

function isLowSurrogate(code: number): boolean {
  return code >= 0xdc00 && code <= 0xdfff
}

/** 截断单片超长文本，保留末尾最多 maxBytes 个 UTF-8 字节且不切裂 UTF-16 代理对。 */
function sliceTailByUtf8Bytes(
  data: string,
  maxBytes: number,
): { text: string; droppedUnits: number } {
  if (maxBytes <= 0) return { text: "", droppedUnits: data.length }
  let usedBytes = 0
  let index = data.length
  while (index > 0) {
    const code = data.charCodeAt(index - 1)
    let stepUnits = 1
    let stepBytes: number
    if (isLowSurrogate(code) && index >= 2 && isHighSurrogate(data.charCodeAt(index - 2))) {
      stepUnits = 2
      stepBytes = 4
    } else if (code <= 0x7f) {
      stepBytes = 1
    } else if (code <= 0x7ff) {
      stepBytes = 2
    } else {
      stepBytes = 3
    }
    if (usedBytes + stepBytes > maxBytes) break
    usedBytes += stepBytes
    index -= stepUnits
  }
  return { text: data.slice(index), droppedUnits: index }
}

/** 单个终端实例的有界回滚缓冲与单调 UTF-16 游标。 */
export class TerminalScrollback {
  private readonly chunks: ScrollbackChunk[] = []
  private bufferedBytes = 0
  private startCursor = 0
  private endCursor = 0

  constructor(private readonly maxBytes: number) {}

  get cursor(): number {
    return this.endCursor
  }

  /** 写入一条 PTY 输出并按 maxBytes 维护环形回滚缓冲，返回更新后的单调游标。 */
  append(data: string): number {
    if (data.length === 0) return this.endCursor
    const start = this.endCursor
    this.endCursor += data.length

    if (this.maxBytes <= 0) {
      this.chunks.length = 0
      this.bufferedBytes = 0
      this.startCursor = this.endCursor
      return this.endCursor
    }

    const bytes = Buffer.byteLength(data, "utf8")
    if (bytes > this.maxBytes) {
      this.chunks.length = 0
      const { text, droppedUnits } = sliceTailByUtf8Bytes(data, this.maxBytes)
      this.startCursor = start + droppedUnits
      if (text.length > 0) {
        const keptBytes = Buffer.byteLength(text, "utf8")
        this.chunks.push({ start: this.startCursor, data: text, bytes: keptBytes })
        this.bufferedBytes = keptBytes
      } else {
        this.bufferedBytes = 0
      }
      return this.endCursor
    }

    this.chunks.push({ start, data, bytes })
    this.bufferedBytes += bytes
    while (this.bufferedBytes > this.maxBytes && this.chunks.length > 0) {
      const removed = this.chunks.shift()!
      this.bufferedBytes -= removed.bytes
      // 若前一片末尾恰好以高代理结束、下一片以低代理开始，跳过孤立低代理码元避免损坏。
      const next = this.chunks[0]
      if (
        next &&
        next.data.length > 0 &&
        isHighSurrogate(removed.data.charCodeAt(removed.data.length - 1)) &&
        isLowSurrogate(next.data.charCodeAt(0))
      ) {
        const trimmed = next.data.slice(1)
        const nextBytes = Buffer.byteLength(trimmed, "utf8")
        this.bufferedBytes -= next.bytes - nextBytes
        if (trimmed.length > 0) {
          next.start += 1
          next.data = trimmed
          next.bytes = nextBytes
        } else {
          this.chunks.shift()
        }
      }
    }
    this.startCursor = this.chunks[0]?.start ?? this.endCursor
    return this.endCursor
  }

  /** 从回滚缓冲切出 [Math.max(afterCursor, startCursor), endCursor) 的文本，不切裂代理对。 */
  readReplay(afterCursor: number): { replay: string; truncated: boolean } {
    if (!Number.isInteger(afterCursor) || afterCursor < 0) {
      throw new Error(`invalid terminal cursor: ${afterCursor}`)
    }
    const truncated = afterCursor < this.startCursor
    if (afterCursor >= this.endCursor || this.chunks.length === 0) {
      return { replay: "", truncated }
    }
    const from = Math.max(afterCursor, this.startCursor)
    const parts: string[] = []
    for (let i = 0; i < this.chunks.length; i += 1) {
      const chunk = this.chunks[i]!
      const chunkEnd = chunk.start + chunk.data.length
      if (chunkEnd <= from) continue
      if (chunk.start < from) {
        let offset = from - chunk.start
        if (
          offset < chunk.data.length &&
          isLowSurrogate(chunk.data.charCodeAt(offset)) &&
          isHighSurrogate(chunk.data.charCodeAt(offset - 1))
        ) {
          offset += 1
        }
        parts.push(chunk.data.slice(offset))
      } else {
        let slice = chunk.data
        // 若 from 刚好等于当前分片起点且跨分片落在代理对中间，跳过前导低代理。
        if (parts.length === 0 && from === chunk.start && i > 0 && slice.length > 0) {
          const prev = this.chunks[i - 1]!
          if (
            prev.data.length > 0 &&
            isHighSurrogate(prev.data.charCodeAt(prev.data.length - 1)) &&
            isLowSurrogate(slice.charCodeAt(0))
          ) {
            slice = slice.slice(1)
          }
        }
        parts.push(slice)
      }
    }
    return { replay: parts.join(""), truncated }
  }
}
