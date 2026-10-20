/** 把 JSONL fixture 回放为 app-server：按客户端请求应答并推送录制帧。 */
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { ReplayCodexTransport } from "./transport"

/** 收窄后的 JSON 对象帧。 */
type Frame = Record<string, unknown>

/** 回放传输：握手响应由请求方法合成，录制帧按文件顺序推送。 */
export class FixtureCodexTransport extends ReplayCodexTransport {
  private cursor = 0
  private awaitingResponseId: string | number | null = null
  private readonly timers = new Set<ReturnType<typeof setTimeout>>()

  constructor(private readonly frames: Frame[]) {
    super([])
  }

  /** 拦截客户端消息：请求立即应答，server request 的响应继续回放。 */
  override send(line: string): void {
    super.send(line)
    const message = parseFrame(line)
    if (!message) return
    const method = typeof message.method === "string" ? message.method : undefined
    const id = message.id
    if (!method) {
      if (this.awaitingResponseId !== null && sameId(this.awaitingResponseId, id)) {
        this.awaitingResponseId = null
        this.scheduleAdvance()
      }
      return
    }
    if (!isRequestId(id)) return
    switch (method) {
      case "initialize":
        this.reply(id, {})
        break
      case "thread/start":
        this.reply(id, { thread: { id: "th_native" } })
        break
      case "thread/resume": {
        const params = asFrame(message.params)
        const threadId =
          params && typeof params.threadId === "string" ? params.threadId : "th_native"
        this.reply(id, { thread: { id: threadId } })
        break
      }
      case "turn/start":
        this.reply(id, { turn: { id: "turn_1" } })
        this.scheduleAdvance()
        break
      case "turn/interrupt":
        this.reply(id, {})
        break
      default:
        break
    }
  }

  override close(): void {
    for (const timer of this.timers) clearTimeout(timer)
    this.timers.clear()
    super.close()
  }

  /** 以同 id 的 result 应答客户端请求。 */
  private reply(id: string | number, result: unknown): void {
    this.push({ jsonrpc: "2.0", id, result })
  }

  /** 延迟到请求的 promise 回调之后再推送，避免终态早于 turnId 记录。 */
  private scheduleAdvance(): void {
    const timer = setTimeout(() => {
      this.timers.delete(timer)
      this.advance()
    }, 0)
    this.timers.add(timer)
  }

  /** 顺序推送录制帧；遇到 server request 时暂停等待客户端响应。 */
  private advance(): void {
    while (this.cursor < this.frames.length) {
      const frame = this.frames[this.cursor]
      if (!frame) return
      this.cursor += 1
      const method = typeof frame.method === "string" ? frame.method : undefined
      const id = frame.id
      if (method && isRequestId(id)) {
        this.awaitingResponseId = id
        this.push(frame)
        return
      }
      this.push(frame)
    }
  }
}

/** 读取 JSONL 并构造回放传输；相对路径以本文件所在目录为基准。 */
export function replayTransport(file: string): FixtureCodexTransport {
  return new FixtureCodexTransport(readFrames(file))
}

/** 读取 JSONL 帧列表；无法解析的行忽略。 */
function readFrames(file: string): Frame[] {
  const path = file.startsWith("/") ? file : join(import.meta.dirname, file)
  return readFileSync(path, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => parseFrame(line) ?? {})
}

/** 把一行 JSON 解析为对象；非法行返回 undefined。 */
function parseFrame(line: string): Frame | undefined {
  let value: unknown
  try {
    value = JSON.parse(line)
  } catch {
    return undefined
  }
  return asFrame(value)
}

/** 把未知值收窄为普通对象；数组与 null 视为无效。 */
function asFrame(value: unknown): Frame | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Frame)
    : undefined
}

/** 判断值是否可作为 JSON-RPC id。 */
function isRequestId(value: unknown): value is string | number {
  return typeof value === "string" || typeof value === "number"
}

/** 比较 JSON-RPC id；兼容字符串与数字。 */
function sameId(left: unknown, right: unknown): boolean {
  return (typeof left === "string" || typeof left === "number") && left === right
}
