/** 一对内存双工传输，用于 Host 与 Renderer 的集成测试。 */
import type { HostTransport } from "@pigcode/client-runtime"

/** 双工传输的一端；发送时把消息投递给对端。 */
class Side implements HostTransport {
  private listeners = new Set<(message: unknown) => void>()
  private queue: unknown[] = []
  private waiters: Array<(value: unknown) => void> = []
  peer!: Side

  send(message: unknown): void {
    const target = this.peer
    for (const listener of target.listeners) listener(message)
    const waiter = target.waiters.shift()
    if (waiter) waiter(message)
    else target.queue.push(message)
  }

  onMessage(listener: (message: unknown) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  /** 取出下一条收到的消息；队列为空时等待新消息。 */
  next(): Promise<unknown> {
    const value = this.queue.shift()
    if (value !== undefined) return Promise.resolve(value)
    return new Promise((resolve) => this.waiters.push(resolve))
  }

  close(): void {
    this.listeners.clear()
    this.queue.length = 0
    this.waiters.length = 0
  }
}

/** 内存双工传输，host 与 client 两个端点互为对端。 */
export class MemoryTransport {
  readonly host = new Side()
  readonly client = new Side()

  constructor() {
    this.host.peer = this.client
    this.client.peer = this.host
  }
}
