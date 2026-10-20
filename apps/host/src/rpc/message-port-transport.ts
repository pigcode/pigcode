/** 把 Electron utilityProcess 收到的 MessagePort 适配成 HostTransport。 */
import type { HostTransport } from "@pigcode/client-runtime"
import type { MessagePort } from "node:worker_threads"

/** 基于 Node MessagePort 的 Host 侧传输实现。 */
export class MessagePortTransport implements HostTransport {
  private readonly listeners = new Set<(message: unknown) => void>()

  constructor(private readonly port: MessagePort) {
    port.on("message", (message) => {
      for (const listener of this.listeners) listener(message)
    })
    port.start()
  }

  /** 经由 MessagePort 发送一条消息。 */
  send(message: unknown): void {
    this.port.postMessage(message)
  }

  /** 注册消息监听，返回取消函数。 */
  onMessage(listener: (message: unknown) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  /** 关闭底层端口。 */
  close(): void {
    this.port.close()
  }
}
