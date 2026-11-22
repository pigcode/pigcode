import type { Context } from "cordis"
import type { HostTransport } from "@pigcode/client-runtime/transport"
import {
  mobileProjectListParamsSchema,
  mobileProjectListResultSchema,
  mobileRelaySavedSchema,
  mobileSidebarChangedSchema,
  mobileSidebarMethods as methods,
  mobileSidebarLabelLimit,
  mobileSidebarPageSize,
  mobileSidebarSubscribeParamsSchema,
  mobileSidebarSubscribeResultSchema,
  mobileStatusParamsSchema,
  mobileStatusResultSchema,
  mobileThreadListParamsSchema,
  mobileThreadListResultSchema,
  rpcFailureSchema,
  rpcRequestSchema,
  rpcSuccessSchema,
  type RpcRequest,
  type Thread,
} from "@pigcode/contracts"
import type { ThreadFeed } from "../rpc/thread-feed"
import { fingerprint, type PairedDevices } from "./paired-devices"

const mobileRequestSchema = rpcRequestSchema.extend({ id: rpcRequestSchema.shape.id.max(128) })
const pageByteBudget = 48 * 1024

type ErrorCode =
  | "METHOD_NOT_AVAILABLE"
  | "INVALID_PARAMS"
  | "RESOURCE_NOT_AVAILABLE"
  | "RESULT_TOO_LARGE"
  | "COMMAND_FAILED"

const messages: Record<ErrorCode, string> = {
  METHOD_NOT_AVAILABLE: "手机端暂时无法使用此操作。",
  INVALID_PARAMS: "请求参数无效，请检查手机端版本。",
  RESOURCE_NOT_AVAILABLE: "电脑上的这个项目已不可用。",
  RESULT_TOO_LARGE: "此摘要超出手机端可读取的大小。",
  COMMAND_FAILED: "电脑暂时无法处理此请求。",
}

class MobileRequestError extends Error {
  constructor(readonly code: ErrorCode) {
    super(messages[code])
  }
}

interface MobileSession {
  computerKey: Buffer
  computerName: string
  deviceKey: string
  features: readonly string[]
  relayRevision(): string | undefined
}

function page<T>(
  rows: T[],
  {
    offset = 0,
    limit = mobileSidebarPageSize,
  }: { offset?: number | undefined; limit?: number | undefined },
): T[] {
  const result: T[] = []
  let size = 2
  for (const row of rows.slice(offset, offset + limit)) {
    size += Buffer.byteLength(JSON.stringify(row)) + 1
    if (size > pageByteBudget) {
      if (result.length === 0) throw new MobileRequestError("RESULT_TOO_LARGE")
      break
    }
    result.push(row)
  }
  return result
}

function displayLabel(text: string): string {
  if (text.length <= mobileSidebarLabelLimit) return text
  const prefix = text.slice(0, mobileSidebarLabelLimit - 1)
  return prefix.replace(/[\uD800-\uDBFF]$/, "") + "…"
}

function threadSummary(thread: Thread) {
  return {
    id: thread.id,
    projectId: thread.projectId,
    title: displayLabel(thread.title),
    updatedAt: thread.updatedAt,
    archived: thread.archivedAt !== null,
    pinned: false,
    status: thread.status ?? "idle",
    unread: thread.unread ?? false,
  }
}

function params<T>(
  schema: { safeParse(value: unknown): { success: true; data: T } | { success: false } },
  input: unknown,
): T {
  const result = schema.safeParse(input === undefined ? {} : input)
  if (!result.success) throw new MobileRequestError("INVALID_PARAMS")
  return result.data
}

/** Read-only mobile allowlist. It never dispatches through the desktop RPC server. */
export class MobileSidebarRpc {
  private stopMessages: (() => void) | undefined
  private stopSidebar: (() => void) | undefined
  private queued = false
  private cachedProjects: Array<{ id: string; name: string }> | undefined
  private cachedThreads: ReturnType<typeof threadSummary>[] | undefined

  constructor(
    private readonly ctx: Context,
    private readonly feed: ThreadFeed,
    private readonly transport: HostTransport,
    private readonly devices: PairedDevices,
    private readonly session: MobileSession,
  ) {}

  start(): void {
    this.stopMessages = this.transport.onMessage((message) => this.receive(message))
  }

  stop(): void {
    this.stopMessages?.()
    this.stopSidebar?.()
    this.stopSidebar = undefined
    this.clearSnapshots()
    this.transport.close()
  }

  private receive(message: unknown): void {
    const receipt = mobileRelaySavedSchema.safeParse(message)
    if (receipt.success) {
      if (
        this.session.features.includes("relay.saveReceipt") &&
        receipt.data.relayRevision === this.session.relayRevision()
      ) {
        this.devices.acknowledgeRelay(this.session.deviceKey, receipt.data.relayRevision)
      }
      return
    }

    const request = mobileRequestSchema.safeParse(message)
    if (!request.success) return
    const { id } = request.data
    let response: unknown
    try {
      const result = this.dispatch(request.data)
      response = rpcSuccessSchema.parse({ jsonrpc: "2.0", id, result })
    } catch (error) {
      const code = error instanceof MobileRequestError ? error.code : "COMMAND_FAILED"
      if (code === "COMMAND_FAILED") console.error("[host] mobile request failed", error)
      response = rpcFailureSchema.parse({
        jsonrpc: "2.0",
        id,
        error: { code, message: messages[code], retryable: code === "COMMAND_FAILED" },
      })
    }
    this.transport.send(response)
  }

  private dispatch(request: RpcRequest): unknown {
    if (request.method === methods.status && this.session.features.includes("connection.status")) {
      params(mobileStatusParamsSchema, request.params)
      return mobileStatusResultSchema.parse({
        computerId: fingerprint(this.session.computerKey),
        computerName: this.session.computerName,
        deviceId: fingerprint(Buffer.from(this.session.deviceKey, "base64url")),
      })
    }
    if (!this.session.features.includes("sidebar.read"))
      throw new MobileRequestError("METHOD_NOT_AVAILABLE")

    switch (request.method) {
      case methods.projectList: {
        const query = params(mobileProjectListParamsSchema, request.params)
        const rows = this.projectRows()
        return mobileProjectListResultSchema.parse(page(rows, query))
      }
      case methods.threadList: {
        const query = params(mobileThreadListParamsSchema, request.params)
        const projects = this.projectRows()
        if (query.projectId && !projects.some(({ id }) => id === query.projectId)) {
          throw new MobileRequestError("RESOURCE_NOT_AVAILABLE")
        }
        const threads = this.threadRows(projects)
        const rows = query.projectId
          ? threads.filter((thread) => thread.projectId === query.projectId)
          : threads
        return mobileThreadListResultSchema.parse(page(rows, query))
      }
      case methods.subscribe:
        params(mobileSidebarSubscribeParamsSchema, request.params)
        this.subscribeSidebar()
        return mobileSidebarSubscribeResultSchema.parse({})
      default:
        throw new MobileRequestError("METHOD_NOT_AVAILABLE")
    }
  }

  private projectRows() {
    if (this.cachedProjects) return this.cachedProjects
    const rows = this.ctx.projects.list().map(({ id, name }) => ({ id, name: displayLabel(name) }))
    if (this.stopSidebar) this.cachedProjects = rows
    return rows
  }

  private threadRows(projects: Array<{ id: string }>) {
    if (this.cachedThreads) return this.cachedThreads
    const active = new Set(projects.map(({ id }) => id))
    const rows = this.ctx.threads
      .list()
      .filter((thread) => !thread.parentThreadId && active.has(thread.projectId))
      .map(threadSummary)
    if (this.stopSidebar) this.cachedThreads = rows
    return rows
  }

  private clearSnapshots(): void {
    this.cachedProjects = undefined
    this.cachedThreads = undefined
  }

  private subscribeSidebar(): void {
    if (this.stopSidebar) return
    const changed = () => {
      this.clearSnapshots()
      if (this.queued) return
      this.queued = true
      queueMicrotask(() => {
        this.queued = false
        if (this.stopSidebar) {
          this.transport.send({
            jsonrpc: "2.0",
            method: methods.changed,
            params: mobileSidebarChangedSchema.parse({}),
          })
        }
      })
    }
    const stopProjects = this.ctx.projects.subscribe(changed)
    const stopThreads = this.feed.subscribe(changed)
    this.stopSidebar = () => {
      stopProjects()
      stopThreads()
    }
  }
}

export function serveMobileSidebar(
  ctx: Context,
  feed: ThreadFeed,
  devices: PairedDevices,
  session: MobileSession,
  send: (message: unknown) => void,
) {
  let receiver: ((message: unknown) => void) | undefined
  const rpc = new MobileSidebarRpc(
    ctx,
    feed,
    {
      send,
      onMessage(listener) {
        receiver = listener
        return () => {
          receiver = undefined
        }
      },
      close() {
        receiver = undefined
      },
    },
    devices,
    session,
  )
  rpc.start()
  return {
    receive: (message: unknown) => receiver?.(message),
    close: () => rpc.stop(),
  }
}
