import type { Context } from "cordis"
import type { HostTransport } from "@pigcode/client-runtime/transport"
import {
  mobileProjectListParamsSchema,
  mobileProjectListResultSchema,
  mobileCommandMethods,
  mobileReceiptParams,
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
import { MobileCommandReceipts, requireMobileThread } from "./command-receipts"
import { MobileRequestCommands, mobileRequestCommands } from "./request-commands"
import { mobileErrorMessages, mobileParams as params, MobileRequestError } from "./request-error"
import { MobileRunCommands, mobileRunCommandRequests } from "./run-commands"
import { MobileTimelineSession, mobileTimelineRequests } from "./timeline"

const mobileRequestSchema = rpcRequestSchema.extend({ id: rpcRequestSchema.shape.id.max(128) })
const pageByteBudget = 48 * 1024

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

/** Mobile allowlist. It never dispatches through the desktop RPC server. */
export class MobileSidebarRpc {
  private readonly commands: MobileRunCommands
  private readonly requests: MobileRequestCommands
  private readonly receipts: MobileCommandReceipts
  private active = false
  private readonly timeline: MobileTimelineSession
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
  ) {
    this.receipts = new MobileCommandReceipts(ctx.storage.receipts, session.deviceKey)
    this.commands = new MobileRunCommands(ctx, devices, session.deviceKey, this.receipts)
    this.requests = new MobileRequestCommands(
      ctx,
      this.receipts,
      "device:" + fingerprint(Buffer.from(session.deviceKey, "base64url")),
    )
    this.timeline = new MobileTimelineSession(ctx, (message) => transport.send(message))
  }

  start(): void {
    this.active = true
    this.stopMessages = this.transport.onMessage((message) => this.receive(message))
  }

  stop(): void {
    this.active = false
    this.timeline.close()
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
    void this.reply(request.data).catch((error: unknown) => {
      if (this.active) console.error("[host] mobile reply failed", error)
    })
  }

  private async reply(request: RpcRequest): Promise<void> {
    const { id } = request
    let response: unknown
    try {
      const result = await this.dispatch(request)
      response = rpcSuccessSchema.parse({ jsonrpc: "2.0", id, result })
    } catch (error) {
      const code = error instanceof MobileRequestError ? error.code : "COMMAND_FAILED"
      if (code === "COMMAND_FAILED") console.error("[host] mobile request failed", error)
      response = rpcFailureSchema.parse({
        jsonrpc: "2.0",
        id,
        error: { code, message: mobileErrorMessages[code], retryable: code === "COMMAND_FAILED" },
      })
    }
    if (this.active) this.transport.send(response)
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
    if (
      this.session.features.includes("timeline.read") &&
      mobileTimelineRequests.has(request.method)
    )
      return this.timeline.dispatch(request)

    const canRun = this.session.features.includes("run.write")
    const canRespond = this.session.features.includes("request.write")
    if (canRun && mobileRunCommandRequests.has(request.method)) {
      this.requirePairedDevice()
      return this.commands.dispatch(request)
    }
    if (canRespond && mobileRequestCommands.has(request.method)) {
      this.requirePairedDevice()
      return this.requests.dispatch(request)
    }
    if ((canRun || canRespond) && request.method === mobileCommandMethods.receipt) {
      this.requirePairedDevice()
      const { commandId } = params(mobileReceiptParams, request.params)
      const receipt = this.receipts.lookup(commandId)
      if (!receipt) return {}
      if (mobileRunCommandRequests.has(receipt.method) ? !canRun : !canRespond) return {}
      requireMobileThread(this.ctx, receipt.threadId)
      return { receipt }
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

  private requirePairedDevice(): void {
    if (!this.devices.find(this.session.deviceKey)) throw new MobileRequestError("DEVICE_REVOKED")
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
