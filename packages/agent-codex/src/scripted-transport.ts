/** 测试用的 app-server 替身：按脚本应答 JSON-RPC 请求，并记录客户端发出的消息。 */
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { ReplayCodexTransport } from "./transport"

/** 客户端发出的 JSON-RPC 消息。 */
export interface SentMessage {
  jsonrpc: string
  id?: number | string
  method?: string
  params?: unknown
  result?: unknown
}

/** 服务端应答脚本；在收到客户端消息时推入响应。 */
export interface ReplayScript {
  nativeThreadId: string
  /** thread/fork 返回的新 thread id；未指定时使用固定值。 */
  forkedThreadId?: string
  /** model/list 的应答；未指定时返回单个默认模型。 */
  modelList?: unknown
  onTurnStart?: (message: SentMessage, transport: ScriptedTransport) => void
  onTurnInterrupt?: (message: SentMessage, transport: ScriptedTransport) => void
}

/** 在 ReplayCodexTransport 之上按脚本应答请求，模拟 app-server。 */
export class ScriptedTransport extends ReplayCodexTransport {
  closed = false

  constructor(private readonly script: ReplayScript) {
    super([])
  }

  override send(line: string): void {
    super.send(line)
    const message = JSON.parse(line) as SentMessage
    if (message.method === "initialize") {
      this.push({ id: message.id, result: {} })
      return
    }
    if (message.method === "thread/fork") {
      this.push({
        id: message.id,
        result: { thread: { id: this.script.forkedThreadId ?? "th_forked" } },
      })
      return
    }
    if (message.method === "thread/start" || message.method === "thread/resume") {
      const params = message.params as { threadId?: string } | undefined
      const id = params?.threadId ?? this.script.nativeThreadId
      this.push({ id: message.id, result: { thread: { id } } })
      return
    }
    if (message.method === "model/list") {
      this.push({
        id: message.id,
        result: this.script.modelList ?? {
          data: [{ id: "gpt-6.1-sol", displayName: "GPT-6.1 Sol", isDefault: true }],
        },
      })
      return
    }
    if (message.method === "turn/start") {
      this.script.onTurnStart?.(message, this)
      return
    }
    if (message.method === "turn/interrupt") {
      this.script.onTurnInterrupt?.(message, this)
      this.push({ id: message.id, result: {} })
    }
  }

  override close(): void {
    this.closed = true
    super.close()
  }
}

/** 读取 JSONL fixture 中的服务端帧。 */
export function readFrames(file: string): unknown[] {
  const path = file.startsWith("/") ? file : join(import.meta.dirname, file)
  return readFileSync(path, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as unknown)
}

/** 解析 transport 发出的全部消息。 */
export function sentMessages(transport: ScriptedTransport): SentMessage[] {
  return transport.sent.map((line) => JSON.parse(line) as SentMessage)
}

/** 取最近一条指定方法的客户端消息。 */
export function messageOf(transport: ScriptedTransport, method: string): SentMessage | undefined {
  return sentMessages(transport)
    .filter((message) => message.method === method)
    .at(-1)
}
