/** Codex app-server 的 JSON-RPC 客户端；负责 id 关联与 server request 分发。 */
import type { CodexTransport } from "./transport"

interface Pending {
  resolve(value: unknown): void
  reject(error: Error): void
}

/** 在 NDJSON 传输之上关联请求与响应，并分发通知和 server request。 */
export class CodexRpcClient {
  private nextId = 1
  private readonly pending = new Map<number, Pending>()
  private readonly notificationHandlers = new Map<string, Set<(params: unknown) => void>>()
  private readonly requestHandlers = new Map<string, (params: unknown) => Promise<unknown>>()
  private readonly disposeLine: () => void

  constructor(private readonly transport: CodexTransport) {
    this.disposeLine = transport.onLine((line) => this.handleLine(line))
  }

  /** 发送请求，等待同 id 的响应；超时后拒绝。 */
  request(method: string, params: unknown): Promise<unknown> {
    const id = this.nextId++
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject })
      this.transport.send(JSON.stringify({ jsonrpc: "2.0", id, method, params }))
      setTimeout(() => {
        if (!this.pending.has(id)) return
        this.pending.delete(id)
        reject(new Error(`codex request timeout: ${method}`))
      }, 30000)
    })
  }

  /** 发送不带 id 的通知。 */
  notify(method: string, params: unknown): void {
    this.transport.send(JSON.stringify({ jsonrpc: "2.0", method, params }))
  }

  /** 订阅某个方法的通知；返回取消订阅函数。 */
  onNotification(method: string, handler: (params: unknown) => void): () => void {
    const set = this.notificationHandlers.get(method) ?? new Set()
    set.add(handler)
    this.notificationHandlers.set(method, set)
    return () => set.delete(handler)
  }

  /** 注册服务端请求处理器；同一方法后注册者覆盖先注册者。 */
  onServerRequest(method: string, handler: (params: unknown) => Promise<unknown>): void {
    this.requestHandlers.set(method, handler)
  }

  /** 以结果应答服务端请求。 */
  respond(id: number | string, result: unknown): void {
    this.transport.send(JSON.stringify({ jsonrpc: "2.0", id, result }))
  }

  /** 以 JSON-RPC 错误应答服务端请求。 */
  respondError(id: number | string, code: number, message: string): void {
    this.transport.send(JSON.stringify({ jsonrpc: "2.0", id, error: { code, message } }))
  }

  /** 停止监听并关闭底层传输。 */
  close(): void {
    this.disposeLine()
    this.transport.close()
  }

  private handleLine(line: string): void {
    let value: unknown
    try {
      value = JSON.parse(line)
    } catch {
      return
    }
    if (typeof value !== "object" || value === null) return
    const record = value as Record<string, unknown>
    if (typeof record.method === "string" && "id" in record) {
      const handler = this.requestHandlers.get(record.method)
      if (!handler) {
        this.respondError(
          record.id as number | string,
          -32601,
          `unsupported request: ${record.method}`,
        )
        return
      }
      void handler(record.params).then(
        (result) => this.respond(record.id as number | string, result),
        (error: unknown) =>
          this.respondError(
            record.id as number | string,
            -32000,
            error instanceof Error ? error.message : String(error),
          ),
      )
      return
    }
    if (typeof record.method === "string") {
      for (const handler of this.notificationHandlers.get(record.method) ?? []) {
        handler(record.params)
      }
      return
    }
    if ("id" in record) {
      const entry = this.pending.get(record.id as number)
      if (!entry) return
      this.pending.delete(record.id as number)
      if (record.error) entry.reject(new Error(JSON.stringify(record.error)))
      else entry.resolve(record.result)
    }
  }
}
