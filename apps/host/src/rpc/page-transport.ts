/**
 * 页面连接。页面每次加载（包括刷新）main 都会送来一个新端口；这里换上新端口，RPC 服务不变。
 * 正在进行的 run 把流式输出发给启动它的那个传输，所以必须是同一个对象，刷新后的页面才能接着收到。
 */
import type { HostTransport } from "@pigcode/client-runtime/transport"

export class PageTransport implements HostTransport {
  private current: HostTransport | undefined
  private detach: (() => void) | undefined
  private readonly listeners = new Set<(message: unknown) => void>()

  /** 换上新页面的连接，关掉旧的：旧页面已经不在了。 */
  attach(next: HostTransport): void {
    this.close()
    this.current = next
    this.detach = next.onMessage((message) => {
      for (const listener of this.listeners) listener(message)
    })
  }

  /** 发给当前页面；还没有页面时丢弃，页面连上后会重新读取状态。 */
  send(message: unknown): void {
    this.current?.send(message)
  }

  onMessage(listener: (message: unknown) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  close(): void {
    this.detach?.()
    this.current?.close()
    this.detach = undefined
    this.current = undefined
  }
}
