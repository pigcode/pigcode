/** 管理 MessagePort 连接、线程订阅、cursor 与 RPC 命令。 */
import type { ProviderEvent, TerminalOutput, ThreadEvent } from "@pigcode/contracts"
import { RpcClient } from "./rpc-client"
import type { HostTransport } from "./transport"

/** 连接状态；重连时保留 cursor 继续订阅。 */
export type ConnectionStatus = "connecting" | "connected" | "reconnecting" | "offline"

/** 连接层向上层转发的回调。 */
export interface ConnectionHandlers {
  onEvent(event: ThreadEvent): void
  onDelta(event: { threadId: string; event: ProviderEvent }): void
  onStatus(status: ConnectionStatus): void
}

/** 基于 RpcClient 的线程连接，负责断线重订阅与事件游标维护。 */
export class Connection {
  private client: RpcClient | undefined
  private threadId: string | undefined
  private cursor = 0
  private readonly terminalListeners = new Set<(output: TerminalOutput) => void>()

  constructor(private readonly handlers: ConnectionHandlers) {}

  /** 绑定新的传输层；已有线程时从 cursor 重订阅。 */
  async attach(transport: HostTransport): Promise<void> {
    this.handlers.onStatus(this.client ? "reconnecting" : "connecting")
    this.client = new RpcClient(transport)
    this.client.onNotification((message) => this.handleNotification(message))
    if (this.threadId) await this.subscribe(this.threadId, this.cursor)
    this.handlers.onStatus("connected")
  }

  /** 打开线程并订阅 snapshot + cursor。 */
  async openThread(threadId: string): Promise<void> {
    this.threadId = threadId
    this.cursor = 0
    await this.subscribe(threadId, 0)
  }

  /** 发送用户消息。 */
  async startRun(text: string): Promise<void> {
    if (!this.client || !this.threadId) throw new Error("thread not open")
    await this.client.call("run.start", { threadId: this.threadId, text })
  }

  /** 透传一次 RPC 调用，供项目/线程/插件命令使用。 */
  async call(method: string, params: unknown): Promise<unknown> {
    if (!this.client) throw new Error("host not connected")
    return this.client.call(method, params)
  }

  /** 订阅终端输出通知；右栏关闭时调用返回的函数释放订阅。 */
  onTerminalOutput(listener: (output: TerminalOutput) => void): () => void {
    this.terminalListeners.add(listener)
    return () => {
      this.terminalListeners.delete(listener)
    }
  }

  /** 订阅线程并回放 cursor 之后的事件。 */
  private async subscribe(threadId: string, cursor: number): Promise<void> {
    if (!this.client) throw new Error("host not connected")
    const result = (await this.client.call("thread.subscribe", { threadId, cursor })) as {
      events: ThreadEvent[]
    }
    for (const event of result.events) this.handlers.onEvent(event)
    this.cursor = Math.max(this.cursor, ...result.events.map((event) => event.seq))
  }

  /** 分发服务端推送的线程事件与 provider delta。 */
  private handleNotification(message: unknown): void {
    const value = message as {
      method?: string
      params?: {
        seq?: number
        threadId?: string
        event?: ProviderEvent
        terminalId?: unknown
        data?: unknown
      }
    }
    if (value.method === "terminal.output" && value.params) {
      const { terminalId, data } = value.params
      if (typeof terminalId === "string" && typeof data === "string") {
        for (const listener of [...this.terminalListeners]) listener({ terminalId, data })
      }
      return
    }
    if (value.method === "thread.event" && value.params) {
      const event = value.params as unknown as ThreadEvent
      this.cursor = Math.max(this.cursor, event.seq)
      this.handlers.onEvent(event)
      return
    }
    if (value.method === "thread.delta" && value.params?.threadId && value.params.event) {
      this.handlers.onDelta({ threadId: value.params.threadId, event: value.params.event })
    }
  }
}
