/** 管理 MessagePort 连接、线程订阅、每线程 cursor 与 RPC 命令。 */
import {
  attachmentReadResultSchema,
  attachmentUploadResultSchema,
  projectSchema,
  scheduleRunChangeSchema,
  threadSchema,
  type AgentEvent,
  type AttachmentReadResult,
  type AttachmentReadVariant,
  type AttachmentUploadParams,
  type ImageAttachmentRef,
  type ReasoningEffort,
  type Project,
  type ScheduleRunChange,
  type TerminalOutput,
  type Thread,
  type ThreadEvent,
} from "@pigcode/contracts"
import { AttachmentReadCache } from "./attachments"
import { RpcClient } from "./rpc-client"
import type { HostTransport } from "./transport"

/** 连接状态；重连时保留 cursor 继续订阅。 */
export type ConnectionStatus = "connecting" | "connected" | "reconnecting" | "offline"

export interface DesktopLiveRun {
  text: string
  reasoning: string
  tools: Array<{ id: string; text: string }>
}

/** 连接层向上层转发的回调。 */
export interface ConnectionHandlers {
  onEvent(event: ThreadEvent): void
  /** 订阅回放的一整段历史（可能为空）与它所属的线程；提供时一次交出，不提供时逐条调用 onEvent。 */
  onEvents?(events: ThreadEvent[], threadId: string): void
  onDelta(event: { threadId: string; event: AgentEvent }): void
  onStatus(status: ConnectionStatus): void
  onLiveSnapshot?(threadId: string, live: DesktopLiveRun | null): void
  onScheduledThread?(thread: Thread): void
  /** Host 推来的会话新记录：状态、未读、标题、更新时间或归档变了，打开没打开都会推。 */
  onThreadChanged?(thread: Thread): void
  onProjectsChanged?(projects: Project[]): void
}

/** `thread.subscribe` 的响应结构；Host 尚未返回事件时 events 为空。 */
interface SubscribeResult {
  cursor?: number
  events: ThreadEvent[]
  snapshot?: { live?: DesktopLiveRun }
}

/** 基于 RpcClient 的连接，负责多线程订阅、断线重订阅与事件游标维护。 */
export class Connection {
  private client: RpcClient | undefined
  /** 每次 attach 递增；中途被新的 attach 取代时，旧的一次不再改连接状态。 */
  private attempts = 0
  private receivedProjects = false
  private readonly subscriptions = new Map<string, number>()
  private readonly scheduleRunListeners = new Set<(change: ScheduleRunChange) => void>()
  private readonly terminalListeners = new Set<(output: TerminalOutput) => void>()
  private readonly terminalExitListeners = new Set<
    (exit: { terminalId: string; exitCode: number }) => void
  >()
  private readonly attachmentCache = new AttachmentReadCache()

  constructor(private readonly handlers: ConnectionHandlers) {}

  /** A pushed project list supersedes the result of the initial workspace load. */
  get hasProjectSnapshot(): boolean {
    return this.receivedProjects
  }

  /** 随 Host 传输层替换而递增，供在途回执区分连接。 */
  get connectionRevision(): number {
    return this.attempts
  }

  /**
   * 绑定新的传输层；已有线程时逐个从各自 cursor 重订阅。
   * 返回这次 attach 是否成为当前连接：false 表示中途被新的 attach 取代，
   * 调用方不要把它当成连接成功（例如不要在界面上提示「已重新连接」）。
   */
  async attach(transport: HostTransport): Promise<boolean> {
    const attempt = ++this.attempts
    this.receivedProjects = false
    const previous = this.client
    this.handlers.onStatus(previous ? "reconnecting" : "connecting")
    // 旧连接不会再收到响应：先拒绝在途调用，等它们的界面才能走错误路径而不是一直转圈。
    previous?.close("host connection lost")
    const client = new RpcClient(transport)
    this.client = client
    client.onNotification((message) => this.handleNotification(message))
    try {
      for (const [threadId, cursor] of [...this.subscriptions]) {
        await this.subscribe(threadId, cursor, client)
      }
    } catch (error) {
      if (this.client === client) {
        client.close("host connection lost")
        this.client = undefined
      }
      // 已经被新的 attach 取代时，这次失败与界面无关。
      if (attempt === this.attempts) throw error
      return false
    }
    if (attempt !== this.attempts) return false
    this.handlers.onStatus("connected")
    return true
  }

  /** 打开线程并订阅 snapshot + cursor；重复打开会从 0 重新同步。 */
  async openThread(threadId: string): Promise<void> {
    if (!this.client) throw new Error("host not connected")
    this.subscriptions.set(threadId, 0)
    await this.subscribe(threadId, 0)
  }

  /** 关闭线程：释放 Host 监听器并忘记 cursor。 */
  async closeThread(threadId: string): Promise<void> {
    this.subscriptions.delete(threadId)
    if (this.client) await this.client.call("thread.unsubscribe", { threadId })
  }

  /** 上传单张图片附件到 Host 暂存区，返回轻量附件元数据。 */
  async uploadAttachment(params: AttachmentUploadParams): Promise<ImageAttachmentRef> {
    if (!this.client) throw new Error("host not connected")
    const raw = await this.client.call("attachment.upload", {
      dataBase64: params.dataBase64,
      ...(params.fileName ? { fileName: params.fileName } : {}),
      ...(params.mimeType ? { mimeType: params.mimeType } : {}),
      ...(params.threadId ? { threadId: params.threadId } : {}),
    })
    return attachmentUploadResultSchema.parse(raw).attachment
  }

  /** 读取图片附件的缩略图或原图；按 `(threadId, attachmentId, variant)` 走轻量内存缓存。 */
  async readAttachment(params: {
    attachmentId: string
    threadId?: string | undefined
    variant?: AttachmentReadVariant | undefined
  }): Promise<AttachmentReadResult> {
    const variant = params.variant ?? "full"
    const entry = await this.attachmentCache.load(
      { attachmentId: params.attachmentId, threadId: params.threadId, variant },
      async () => {
        if (!this.client) throw new Error("host not connected")
        const raw = await this.client.call("attachment.read", {
          attachmentId: params.attachmentId,
          ...(params.threadId ? { threadId: params.threadId } : {}),
          variant,
        })
        return attachmentReadResultSchema.parse(raw)
      },
    )
    return entry.result
  }

  /** 读取图片附件并返回可直接放入 `<img src>` 的 data URL（复用同一份内存缓存）。 */
  async readAttachmentDataUrl(params: {
    attachmentId: string
    threadId?: string | undefined
    variant?: AttachmentReadVariant | undefined
  }): Promise<string> {
    const variant = params.variant ?? "full"
    const entry = await this.attachmentCache.load(
      { attachmentId: params.attachmentId, threadId: params.threadId, variant },
      async () => {
        if (!this.client) throw new Error("host not connected")
        const raw = await this.client.call("attachment.read", {
          attachmentId: params.attachmentId,
          ...(params.threadId ? { threadId: params.threadId } : {}),
          variant,
        })
        return attachmentReadResultSchema.parse(raw)
      },
    )
    return entry.dataUrl
  }

  /** 同步查看某张图片附件的指定变体是否已在内存缓存中，避免滚动列表重复闪烁。 */
  peekAttachmentDataUrl(params: {
    attachmentId: string
    threadId?: string | undefined
    variant?: AttachmentReadVariant | undefined
  }): string | undefined {
    return this.attachmentCache.peekDataUrl(params)
  }

  /** 在指定线程发送用户消息；effort 是本次 run 的思考深度，fast 与 ultracode 打开对应模式。 */
  async startRun(
    threadId: string,
    text: string,
    options: {
      effort?: ReasoningEffort | null
      fast?: boolean
      ultracode?: boolean
      commandId?: string
      /** 输入框里 @ 引用的会话（#81）。 */
      references?: ReadonlyArray<{ kind: "thread"; threadId: string }>
      /** 本次发送附带的图片附件 id；有附件时允许 text 为空字符串。 */
      attachmentIds?: readonly string[]
    } = {},
  ): Promise<void> {
    if (!this.client) throw new Error("host not connected")
    await this.client.call("run.start", {
      threadId,
      text,
      ...(options.commandId ? { commandId: options.commandId } : {}),
      ...(options.effort ? { effort: options.effort } : {}),
      ...(options.fast ? { fast: true } : {}),
      ...(options.ultracode ? { ultracode: true } : {}),
      ...(options.references?.length
        ? {
            references: options.references.map((reference) => ({
              kind: reference.kind,
              threadId: reference.threadId,
            })),
          }
        : {}),
      ...(options.attachmentIds?.length ? { attachmentIds: [...options.attachmentIds] } : {}),
    })
  }

  /** 透传一次 RPC 调用，供项目/线程/插件命令使用。 */
  async call(method: string, params: unknown): Promise<unknown> {
    if (!this.client) throw new Error("host not connected")
    return this.client.call(method, params)
  }

  onScheduleRunChange(listener: (change: ScheduleRunChange) => void): () => void {
    this.scheduleRunListeners.add(listener)
    return () => this.scheduleRunListeners.delete(listener)
  }

  /** 订阅终端输出通知；右栏关闭时调用返回的函数释放订阅。 */
  onTerminalOutput(listener: (output: TerminalOutput) => void): () => void {
    this.terminalListeners.add(listener)
    return () => {
      this.terminalListeners.delete(listener)
    }
  }

  /** 订阅终端退出通知：shell 自己结束（例如输入 exit）时，界面据此关掉对应的标签。 */
  onTerminalExit(listener: (exit: { terminalId: string; exitCode: number }) => void): () => void {
    this.terminalExitListeners.add(listener)
    return () => {
      this.terminalExitListeners.delete(listener)
    }
  }

  /** 订阅线程并回放 cursor 之后的事件，随后更新该线程的 cursor。 */
  private async subscribe(threadId: string, cursor: number, client = this.client): Promise<void> {
    if (!client) throw new Error("host not connected")
    const result = (await client.call("thread.subscribe", {
      threadId,
      cursor,
    })) as SubscribeResult
    // 回放途中线程可能已经被关掉：不再分发，界面不该出现一个已经关掉的线程。
    if (!this.subscriptions.has(threadId)) return
    if (this.handlers.onEvents) this.handlers.onEvents(result.events, threadId)
    else for (const event of result.events) this.handlers.onEvent(event)
    if (result.snapshot) this.handlers.onLiveSnapshot?.(threadId, result.snapshot.live ?? null)
    const lastSeq = result.events.reduce((max, event) => Math.max(max, event.seq), cursor)
    const nextCursor = Math.max(cursor, result.cursor ?? 0, lastSeq)
    // 回放期间可能已经收到新事件，cursor 不能退回去。
    const known = this.subscriptions.get(threadId)
    if (known !== undefined) this.subscriptions.set(threadId, Math.max(known, nextCursor))
  }

  /** 分发服务端推送的线程事件与 Agent 的 delta。 */
  private handleNotification(message: unknown): void {
    const value = message as {
      method?: string
      params?: {
        seq?: number
        threadId?: string
        event?: AgentEvent
        terminalId?: unknown
        data?: unknown
        exitCode?: unknown
      }
    }
    if (value.method === "project.changed") {
      const projects = projectSchema.array().safeParse(value.params)
      if (projects.success && this.handlers.onProjectsChanged) {
        this.receivedProjects = true
        this.handlers.onProjectsChanged(projects.data)
      }
      return
    }
    if (value.method === "thread.changed") {
      const thread = threadSchema.safeParse(value.params)
      if (thread.success) this.handlers.onThreadChanged?.(thread.data)
      return
    }
    if (value.method === "schedule.runChanged") {
      const change = scheduleRunChangeSchema.safeParse(value.params)
      if (change.success) {
        if (change.data.thread) this.handlers.onScheduledThread?.(change.data.thread)
        for (const listener of this.scheduleRunListeners) listener(change.data)
      }
      return
    }
    if (value.method === "terminal.output" && value.params) {
      const { terminalId, data } = value.params
      if (typeof terminalId === "string" && typeof data === "string") {
        for (const listener of [...this.terminalListeners]) listener({ terminalId, data })
      }
      return
    }
    if (value.method === "terminal.exit" && value.params) {
      const { terminalId, exitCode } = value.params
      if (typeof terminalId === "string") {
        const code = typeof exitCode === "number" ? exitCode : 0
        for (const listener of [...this.terminalExitListeners]) {
          listener({ terminalId, exitCode: code })
        }
      }
      return
    }
    if (value.method === "thread.event" && value.params) {
      const event = value.params as unknown as ThreadEvent
      const current = this.subscriptions.get(event.threadId)
      // 已关闭的 tab 不再接收事件；Host 的退订与网络竞态都可能留下迟到消息。
      if (current === undefined) return
      this.subscriptions.set(event.threadId, Math.max(current, event.seq))
      this.handlers.onEvent(event)
      return
    }
    if (value.method === "thread.delta" && value.params?.threadId && value.params.event) {
      if (!this.subscriptions.has(value.params.threadId)) return
      this.handlers.onDelta({ threadId: value.params.threadId, event: value.params.event })
    }
  }
}
