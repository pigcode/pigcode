/** Renderer 侧的 RPC 客户端；负责 id 关联和线程事件订阅。 */
import type { HostTransport } from "./transport"

/** 连接被换掉时在途调用的错误码；由 RpcClient 自己产生，不是 Host 返回的。 */
export const CONNECTION_CLOSED = "CONNECTION_CLOSED"

/** Host 返回的失败；code 是 contracts 里的稳定错误码，界面据此决定怎样解释。 */
export class RpcCallError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message)
    this.name = "RpcCallError"
  }
}

/** 一次尚未完成的 RPC 调用。 */
interface Pending {
  resolve: (value: unknown) => void
  reject: (error: Error) => void
}

/** 基于传输层实现的请求/响应关联与通知分发。 */
export class RpcClient {
  private nextId = 1
  private closed = false
  private readonly pending = new Map<string, Pending>()
  private readonly listeners = new Set<(message: unknown) => void>()

  constructor(private readonly transport: HostTransport) {
    transport.onMessage((message) => {
      // 关闭后传输层可能还有迟到的消息；不再分发，避免旧连接的事件混进新连接。
      if (this.closed) return
      const value = message as {
        id?: string
        result?: unknown
        error?: { code?: string; message?: string }
        method?: string
      }
      if (value.id && this.pending.has(value.id)) {
        const entry = this.pending.get(value.id)!
        this.pending.delete(value.id)
        if (value.error) {
          const { code = "COMMAND_FAILED", message = "rpc failed" } = value.error
          entry.reject(new RpcCallError(code, message))
        } else entry.resolve(value.result)
        return
      }
      for (const listener of this.listeners) listener(message)
    })
  }

  /** 发送一次 RPC 调用；响应按 id 关联，错误转换为带错误码的 RpcCallError。 */
  call(method: string, params: unknown): Promise<unknown> {
    // 关闭后发出去的请求不会有人应答，立刻失败比一直等好。
    if (this.closed)
      return Promise.reject(new RpcCallError(CONNECTION_CLOSED, "host connection lost"))
    const id = String(this.nextId++)
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject })
      this.transport.send({ jsonrpc: "2.0", id, method, params })
    })
  }

  /**
   * 关闭连接：拒绝所有在途调用、停止分发消息并关闭传输层。
   * 换连接时在途调用已经没有响应可等，不拒绝的话等它的界面（例如文件标签）会一直停在加载中。
   * 重复调用没有副作用。
   */
  close(reason = "host connection lost"): void {
    if (this.closed) return
    this.closed = true
    const pending = [...this.pending.values()]
    this.pending.clear()
    for (const entry of pending) entry.reject(new RpcCallError(CONNECTION_CLOSED, reason))
    this.listeners.clear()
    this.transport.close()
  }

  /** 订阅不属于任何请求的服务端通知，返回取消函数。 */
  onNotification(listener: (message: unknown) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }
}
