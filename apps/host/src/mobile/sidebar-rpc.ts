import type { Context } from "cordis"
import type { HostTransport } from "@pigcode/client-runtime/transport"
import {
  commandSchemas,
  mobileProjectListParamsSchema,
  mobileProjectListResultSchema,
  mobileRelaySavedSchema,
  mobileReminderReportSchema,
  mobileSidebarChangedSchema,
  mobileSidebarMethods as methods,
  mobileSidebarWrites,
  mobileSidebarLabelLimit,
  mobileSidebarPageSize,
  mobileSidebarSubscribeParamsSchema,
  mobileSidebarSubscribeResultSchema,
  mobileThreadListParamsSchema,
  mobileThreadListResultSchema,
  rpcFailureSchema,
  rpcRequestSchema,
  rpcSuccessSchema,
  type RpcRequest,
  type Thread,
  type MobileSidebarWrite,
  type MobileThreadSummary,
} from "@pigcode/contracts"
import type { ThreadFeed } from "../rpc/thread-feed"
import { dispatchThreadCommand } from "../rpc/thread-commands"
import { QueueOperationError } from "../agents/message-queue"
import { AttachmentError } from "../services/attachments"
import type { PairedDevices } from "./paired-devices"
import { requireMobileThread } from "./command-receipts"
import { mobileErrorMessages, mobileParams as params, MobileRequestError } from "./request-error"
import { MobileDomainRouter, UNHANDLED_MOBILE_REQUEST, type MobileSession } from "./sidebar-domains"

const mobileRequestSchema = rpcRequestSchema.extend({ id: rpcRequestSchema.shape.id.max(128) })
const pageByteBudget = 48 * 1024
const sidebarWrites = new Set<string>(Object.values(mobileSidebarWrites))

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

function threadSummary(thread: Thread, includeReadTarget: boolean): MobileThreadSummary {
  return {
    id: thread.id,
    projectId: thread.projectId,
    title: displayLabel(thread.title),
    updatedAt: thread.updatedAt,
    archived: thread.archivedAt !== null,
    pinned: thread.pinned === true,
    status: thread.status ?? "idle",
    unread: thread.unread ?? false,
    ...(includeReadTarget && thread.readTarget ? { readTarget: thread.readTarget } : {}),
    ...(includeReadTarget && thread.manualUnread ? { manualUnread: thread.manualUnread } : {}),
  }
}

/** Mobile allowlist. It never dispatches through the desktop RPC server. */
export class MobileSidebarRpc {
  private readonly domains: MobileDomainRouter
  private active = false
  private stopMessages: (() => void) | undefined
  private stopSidebar: (() => void) | undefined
  private queued = false
  private cachedProjects: Array<{ id: string; name: string }> | undefined
  private cachedThreads: MobileThreadSummary[] | undefined

  constructor(
    private readonly ctx: Context,
    private readonly feed: ThreadFeed,
    private readonly transport: HostTransport,
    private readonly devices: PairedDevices,
    private readonly session: MobileSession,
  ) {
    this.domains = new MobileDomainRouter(
      ctx,
      feed,
      transport,
      devices,
      session,
      () => this.active,
      () => this.requirePairedDevice(),
    )
  }

  start(): void {
    this.active = true
    this.stopMessages = this.transport.onMessage((message) => this.receive(message))
  }

  stop(): void {
    this.active = false
    this.domains.close()
    this.stopMessages?.()
    this.stopSidebar?.()
    this.stopSidebar = undefined
    this.clearSnapshots()
    this.transport.close()
  }

  private receive(message: unknown): void {
    const notice = mobileReminderReportSchema.safeParse(message)
    if (notice.success) {
      if (this.session.features.includes("reminders.status")) {
        const { enabled, permission } = notice.data
        if (this.session.configureReminders) {
          void this.session.configureReminders({ enabled, permission }).catch(() => {
            console.error("[host] could not store the reminder settings")
          })
        } else this.devices.reportReminders(this.session.deviceKey, { enabled, permission })
      }
      return
    }
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
    const afterReplies: Array<() => void> = []
    let response: unknown
    let ok = false
    try {
      const result = await this.dispatch(request, (callback) => afterReplies.push(callback))
      response = rpcSuccessSchema.parse({ jsonrpc: "2.0", id, result })
      ok = true
    } catch (error) {
      const code =
        error instanceof MobileRequestError ||
        error instanceof QueueOperationError ||
        error instanceof AttachmentError
          ? error.code
          : "COMMAND_FAILED"
      if (code === "COMMAND_FAILED") console.error("[host] mobile request failed", error)
      response = rpcFailureSchema.parse({
        jsonrpc: "2.0",
        id,
        error: { code, message: mobileErrorMessages[code], retryable: code === "COMMAND_FAILED" },
      })
    }
    if (this.active) this.transport.send(response)
    if (ok && this.active) {
      for (const callback of afterReplies) {
        try {
          callback()
        } catch (error) {
          console.error("[host] mobile afterReply hook failed", error)
        }
      }
    }
  }

  private dispatch(request: RpcRequest, onReply: (callback: () => void) => void): unknown {
    const routed = this.domains.dispatch(request, onReply)
    if (routed !== UNHANDLED_MOBILE_REQUEST) return routed

    if (!this.session.features.includes("sidebar.read")) {
      throw new MobileRequestError("METHOD_NOT_AVAILABLE")
    }
    if (this.session.features.includes("sidebar.write") && sidebarWrites.has(request.method)) {
      return this.writeSidebar(request.method as MobileSidebarWrite, request.params)
    }

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

  private writeSidebar(method: MobileSidebarWrite, input: unknown) {
    this.requirePairedDevice()
    if (method === methods.markAllRead) {
      params(commandSchemas[method].strict(), input)
      const projects = new Set(this.ctx.projects.list().map((project) => project.id))
      const changed = this.ctx.threads.markAllRead(
        (thread) => !thread.parentThreadId && projects.has(thread.projectId),
      )
      for (const thread of changed) this.feed.changed(thread.id)
    } else {
      const parsed = commandSchemas[method].strict().safeParse(input)
      if (!parsed.success) throw new MobileRequestError("INVALID_PARAMS")
      requireMobileThread(this.ctx, parsed.data.threadId)
      dispatchThreadCommand(this.ctx, method, parsed.data, (id) => this.feed.changed(id))
    }
    return {}
  }

  private threadRows(projects: Array<{ id: string }>) {
    if (this.cachedThreads) return this.cachedThreads
    const active = new Set(projects.map(({ id }) => id))
    const includeReadTarget = this.session.features.includes("sidebar.write")
    const agentNames = this.session.features.includes("sidebar.presentation")
      ? new Map(this.ctx.agents.list().map(({ id, displayName }) => [id, displayName]))
      : undefined
    const rows = this.ctx.threads
      .list()
      .filter((thread) => !thread.parentThreadId && active.has(thread.projectId))
      .map((thread) => {
        const summary = threadSummary(thread, includeReadTarget)
        if (!agentNames) return summary
        const name = agentNames.get(thread.lastAgentId ?? thread.defaultAgentId)?.trim()
        if (name) summary.agentName = displayLabel(name)
        if (summary.status === "waiting-approval") {
          const pending = this.ctx.agents
            .listPendingRequests(thread.id)
            .filter(({ runId }) => runId === thread.lastRunId)
          const kind = pending.find(({ kind }) => kind === "approval")?.kind ?? pending[0]?.kind
          if (kind) summary.pendingKind = kind
        }
        return summary
      })
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
