/** 把 Electron utilityProcess 收到的 MessagePort 适配成 HostTransport。 */
import type { HostTransport } from "@pigcode/client-runtime/transport"

/** Host 侧端口的最小接口；Electron 与 Node 的 message 事件形状不同。 */
export interface HostMessagePort {
  on(event: "message", listener: (value: unknown) => void): void
  start(): void
  postMessage(message: unknown): void
  close(): void
}

/** 把 Electron MessagePortMain 的 MessageEvent 归一化为原始消息。 */
function unwrapMessage(value: unknown): unknown {
  if (typeof value === "object" && value !== null && "data" in value && "ports" in value) {
    return (value as { data: unknown }).data
  }
  return value
}

/** 基于 MessagePort 的 Host 侧传输实现。 */
export class MessagePortTransport implements HostTransport {
  private readonly listeners = new Set<(message: unknown) => void>()

  constructor(private readonly port: HostMessagePort) {
    port.on("message", (value) => {
      const message = unwrapMessage(value)
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
