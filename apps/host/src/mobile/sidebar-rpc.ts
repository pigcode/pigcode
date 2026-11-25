import type { Context } from "cordis"
import type { HostTransport } from "@pigcode/client-runtime/transport"
import {
  commandSchemas,
  mobileProjectListParamsSchema,
  mobileProjectListResultSchema,
  mobileCommandMethods,
  mobileDraftMethods,
  mobileReceiptParams,
  mobileRelaySavedSchema,
  mobileReminderMethods,
  mobileReminderReportSchema,
  mobileReminderSettingsSchema,
  mobileSidebarChangedSchema,
  mobileSidebarMethods as methods,
  mobileSidebarWrites,
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
  type MobileReminderSettings,
  type MobileSidebarWrite,
  type MobileThreadSummary,
  type QueueReceipt,
  type QueueSnapshot,
} from "@pigcode/contracts"
import type { ThreadFeed } from "../rpc/thread-feed"
import { dispatchThreadCommand } from "../rpc/thread-commands"
import { QueueOperationError } from "../agents/message-queue"
import { AttachmentError } from "../services/attachments"
import { dispatchQueuedMessage, queueRequestNames } from "../rpc/queued-message-commands"
import { fingerprint, type PairedDevices } from "./paired-devices"
import { MobileAttachments, mobileAttachmentRequests } from "./attachments"
import { MobileCommandReceipts, requireMobileThread } from "./command-receipts"
import { MobileComposerCommands, mobileComposerRequests } from "./composer-commands"
import { MobileDraftCommands, mobileDraftRequests } from "./draft-commands"
import { MobileMentionCommands, mobileMentionRequests } from "./mentions"
import { MobileRequestCommands, mobileRequestCommands } from "./request-commands"
import { mobileErrorMessages, mobileParams as params, MobileRequestError } from "./request-error"
import { legacyRunReceipt, MobileRunCommands, mobileRunCommandRequests } from "./run-commands"
import { MobileRunChanges, mobileRunChangesRequests } from "./run-changes"
import { MobileTimelineSession, mobileTimelineRequests } from "./timeline"
import { MobilePreview, mobilePreviewRequests } from "./preview"
import { MobileWorkbench, mobileWorkbenchRequests } from "./workbench"

const mobileRequestSchema = rpcRequestSchema.extend({ id: rpcRequestSchema.shape.id.max(128) })
const pageByteBudget = 48 * 1024
const sidebarWrites = new Set<string>(Object.values(mobileSidebarWrites))

interface MobileSession {
  computerKey: Buffer
  computerName: string
  deviceKey: string
  features: readonly string[]
  relayRevision(): string | undefined
  configureReminders?(settings: MobileReminderSettings): Promise<boolean>
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

/** 旧客户端未协商 composer.attachments 时剥离待发队列中的 attachments 字段以保持严格解析兼容。 */
function stripQueueAttachments(value: QueueSnapshot | QueueReceipt): QueueSnapshot | QueueReceipt {
  if ("messages" in value) {
    return {
      ...value,
      messages: value.messages.map(({ attachments: _attachments, ...rest }) => rest),
    }
  }
  const { attachments: _attachments, ...rest } = value
  return rest
}

/** Mobile allowlist. It never dispatches through the desktop RPC server. */
export class MobileSidebarRpc {
  private readonly commands: MobileRunCommands
  private readonly requests: MobileRequestCommands
  private readonly drafts: MobileDraftCommands
  private readonly composer: MobileComposerCommands
  private readonly mentions: MobileMentionCommands
  private readonly attachments: MobileAttachments
  private readonly workbench: MobileWorkbench
  private readonly preview: MobilePreview
  private readonly receipts: MobileCommandReceipts
  private active = false
  private readonly timeline: MobileTimelineSession
  private readonly changes: MobileRunChanges
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
    this.receipts = new MobileCommandReceipts(ctx.storage.receipts, session.deviceKey)
    this.changes = new MobileRunChanges(ctx)
    const canQueue = session.features.includes("queue.write")
    const canComposer = session.features.includes("composer.controls")
    const canAttachments = session.features.includes("composer.attachments")
    this.commands = new MobileRunCommands(
      ctx,
      devices,
      session.deviceKey,
      this.receipts,
      canQueue,
      canComposer,
      canAttachments,
    )
    this.drafts = new MobileDraftCommands(
      ctx,
      devices,
      session.deviceKey,
      this.receipts,
      canComposer,
      canAttachments,
    )
    this.requests = new MobileRequestCommands(
      ctx,
      this.receipts,
      "device:" + fingerprint(Buffer.from(session.deviceKey, "base64url")),
    )
    this.timeline = new MobileTimelineSession(
      ctx,
      (message) => transport.send(message),
      canQueue,
      session.features.includes("timeline.resume"),
      session.features.includes("changes.read"),
      canComposer,
      feed,
      canAttachments,
    )
    this.composer = new MobileComposerCommands(
      ctx,
      () => this.requirePairedDevice(),
      (threadId) => {
        this.feed.changed(threadId)
        this.timeline.notifyComposer(threadId)
      },
      canAttachments,
    )
    this.mentions = new MobileMentionCommands(ctx, () => this.requirePairedDevice())
    this.attachments = new MobileAttachments(ctx, session.deviceKey, () =>
      this.requirePairedDevice(),
    )
    this.workbench = new MobileWorkbench(ctx, () => this.requirePairedDevice())
    this.preview = new MobilePreview(ctx, session.deviceKey, () => this.requirePairedDevice())
  }

  start(): void {
    this.active = true
    this.stopMessages = this.transport.onMessage((message) => this.receive(message))
  }

  stop(): void {
    this.active = false
    this.attachments.close()
    this.preview.close()
    this.timeline.close()
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
    let response: unknown
    try {
      const result = await this.dispatch(request)
      response = rpcSuccessSchema.parse({ jsonrpc: "2.0", id, result })
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
  }

  private dispatch(request: RpcRequest): unknown {
    if (request.method === mobileReminderMethods.configure &&
        this.session.features.includes("reminders.apns") && this.session.configureReminders) {
      this.requirePairedDevice()
      const settings = params(mobileReminderSettingsSchema, request.params)
      return this.session.configureReminders(settings).then((saved) => ({ saved }))
    }
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

    if (this.session.features.includes("changes.read") && mobileRunChangesRequests.has(request.method)) {
      this.requirePairedDevice()
      return this.changes.dispatch(request)
    }

    if (
      this.session.features.includes("workbench.read") &&
      mobileWorkbenchRequests.has(request.method)
    ) {
      this.requirePairedDevice()
      return this.workbench.dispatch(request)
    }

    if (
      this.session.features.includes("preview.tunnel") &&
      mobilePreviewRequests.has(request.method)
    ) {
      this.requirePairedDevice()
      return this.preview.dispatch(request)
    }

    const canRun = this.session.features.includes("run.write")
    const canRespond = this.session.features.includes("request.write")
    const canDraft = this.session.features.includes("draft.write")
    const canQueue = this.session.features.includes("queue.write")
    const canComposer = this.session.features.includes("composer.controls")
    const canMentions = this.session.features.includes("composer.mentions")
    const canAttachments = this.session.features.includes("composer.attachments")
    if (canAttachments && mobileAttachmentRequests.has(request.method)) {
      this.requirePairedDevice()
      return this.attachments.dispatch(request)
    }
    if (canMentions && mobileMentionRequests.has(request.method)) {
      this.requirePairedDevice()
      return this.mentions.dispatch(request)
    }
    if (canComposer && mobileComposerRequests.has(request.method)) {
      this.requirePairedDevice()
      return this.composer.dispatch(request)
    }
    if (canRun && mobileRunCommandRequests.has(request.method)) {
      this.requirePairedDevice()
      return this.commands.dispatch(request)
    }
    if (canRespond && mobileRequestCommands.has(request.method)) {
      this.requirePairedDevice()
      return this.requests.dispatch(request)
    }
    if (
      (canDraft && mobileDraftRequests.has(request.method)) ||
      (canComposer &&
        (request.method === mobileDraftMethods.options ||
          request.method === mobileDraftMethods.models))
    ) {
      this.requirePairedDevice()
      return this.drafts.dispatch(request)
    }
    if (canQueue && queueRequestNames.has(request.method)) {
      this.requirePairedDevice()
      const result = dispatchQueuedMessage(
        this.ctx,
        this.receipts,
        request.method,
        request.params,
        (threadId) => requireMobileThread(this.ctx, threadId),
        this.devices.queueSource(this.session.deviceKey),
      )
      return canAttachments ? result : stripQueueAttachments(result)
    }
    if (
      (canRun || canRespond || canDraft || canQueue) &&
      request.method === mobileCommandMethods.receipt
    ) {
      this.requirePairedDevice()
      const { commandId } = params(mobileReceiptParams, request.params)
      const receipt = this.receipts.lookup(commandId)
      if (!receipt) return {}
      const allowed =
        receipt.method === mobileDraftMethods.create
          ? canDraft
          : queueRequestNames.has(receipt.method)
            ? canQueue
            : mobileRunCommandRequests.has(receipt.method)
              ? canRun
              : canRespond
      if (!allowed) return {}
      requireMobileThread(this.ctx, receipt.threadId)
      if (!canQueue && "queuedMessageId" in receipt) return { receipt: legacyRunReceipt(receipt) }
      if (!canAttachments && "attachments" in receipt) {
        const { attachments: _attachments, ...rest } = receipt
        return { receipt: rest }
      }
      return { receipt }
    }

    if (!this.session.features.includes("sidebar.read"))
      throw new MobileRequestError("METHOD_NOT_AVAILABLE")
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
      const changed = this.ctx.threads.markAllRead((thread) =>
        !thread.parentThreadId && projects.has(thread.projectId),
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
