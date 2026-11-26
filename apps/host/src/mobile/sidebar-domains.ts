/** 手机端 RPC 子域路由器：组装并按协商特性分发各业务域处理器，统一管理其生命周期关闭。 */
import type { HostTransport } from "@pigcode/client-runtime/transport"
import {
  mobileCommandMethods,
  mobileDraftMethods,
  mobileReceiptParams,
  mobileReminderMethods,
  mobileReminderSettingsSchema,
  mobileSidebarMethods as methods,
  mobileStatusParamsSchema,
  mobileStatusResultSchema,
  type MobileReminderSettings,
  type QueueReceipt,
  type QueueSnapshot,
  type RpcRequest,
} from "@pigcode/contracts"
import type { Context } from "cordis"
import { dispatchQueuedMessage, queueRequestNames } from "../rpc/queued-message-commands"
import type { ThreadFeed } from "../rpc/thread-feed"
import { MobileAgentManage, mobileAgentRequests } from "./agent-manage"
import { MobileAttachments, mobileAttachmentRequests } from "./attachments"
import { MobileCommandReceipts, requireMobileThread } from "./command-receipts"
import { MobileComposerCommands, mobileComposerRequests } from "./composer-commands"
import { MobileDraftCommands, mobileDraftRequests } from "./draft-commands"
import { MobileMentionCommands, mobileMentionRequests } from "./mentions"
import { fingerprint, type PairedDevices } from "./paired-devices"
import { MobilePreview, mobilePreviewRequests } from "./preview"
import { MobileProjectManage, mobileProjectRequests } from "./project-manage"
import { MobileRequestCommands, mobileRequestCommands } from "./request-commands"
import { mobileParams as params } from "./request-error"
import { MobileRunChanges, mobileRunChangesRequests } from "./run-changes"
import { legacyRunReceipt, MobileRunCommands, mobileRunCommandRequests } from "./run-commands"
import { MobileTerminalSession, mobileTerminalRequests } from "./terminal"
import { MobileTimelineSession, mobileTimelineRequests } from "./timeline"
import { MobileWorkbench, mobileWorkbenchRequests } from "./workbench"
import { MobileWorkbenchWrite, mobileWorkbenchWriteRequests } from "./workbench-write"

export interface MobileSession {
  computerKey: Buffer
  computerName: string
  deviceKey: string
  features: readonly string[]
  relayRevision(): string | undefined
  configureReminders?(settings: MobileReminderSettings): Promise<boolean>
}

export const UNHANDLED_MOBILE_REQUEST = Symbol("UNHANDLED_MOBILE_REQUEST")

function omitAttachments<T extends { attachments?: unknown }>(value: T): Omit<T, "attachments"> {
  const next = { ...value }
  delete next.attachments
  return next
}

/** 旧客户端未协商 composer.attachments 时剥离待发队列中的 attachments 字段以保持严格解析兼容。 */
function stripQueueAttachments(value: QueueSnapshot | QueueReceipt): QueueSnapshot | QueueReceipt {
  if ("messages" in value) {
    return {
      ...value,
      messages: value.messages.map((item) => omitAttachments(item)),
    }
  }
  return omitAttachments(value)
}

export class MobileDomainRouter {
  private readonly commands: MobileRunCommands
  private readonly requests: MobileRequestCommands
  private readonly drafts: MobileDraftCommands
  private readonly composer: MobileComposerCommands
  private readonly mentions: MobileMentionCommands
  private readonly attachments: MobileAttachments
  private readonly workbench: MobileWorkbench
  private readonly workbenchWrite: MobileWorkbenchWrite
  private readonly preview: MobilePreview
  private readonly terminal: MobileTerminalSession
  private readonly projectManage: MobileProjectManage
  private readonly agentManage: MobileAgentManage
  private readonly receipts: MobileCommandReceipts
  private readonly timeline: MobileTimelineSession
  private readonly changes: MobileRunChanges

  constructor(
    private readonly ctx: Context,
    feed: ThreadFeed,
    transport: HostTransport,
    private readonly devices: PairedDevices,
    private readonly session: MobileSession,
    isActive: () => boolean,
    private readonly requirePairedDevice: () => void,
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
      requirePairedDevice,
      (threadId) => {
        feed.changed(threadId)
        this.timeline.notifyComposer(threadId)
      },
      canAttachments,
    )
    this.mentions = new MobileMentionCommands(ctx, requirePairedDevice)
    this.attachments = new MobileAttachments(ctx, session.deviceKey, requirePairedDevice)
    this.workbench = new MobileWorkbench(ctx, requirePairedDevice)
    this.workbenchWrite = new MobileWorkbenchWrite(ctx, session.deviceKey, requirePairedDevice)
    this.preview = new MobilePreview(ctx, session.deviceKey, requirePairedDevice)
    this.terminal = new MobileTerminalSession(
      ctx,
      session.deviceKey,
      (message) => {
        if (isActive()) transport.send(message)
      },
      requirePairedDevice,
    )
    this.projectManage = new MobileProjectManage(ctx, requirePairedDevice)
    this.agentManage = new MobileAgentManage(ctx, requirePairedDevice)
  }

  close(): void {
    this.attachments.close()
    this.workbenchWrite.close()
    this.preview.close()
    this.terminal.close()
    this.timeline.close()
  }

  dispatch(request: RpcRequest, onReply: (callback: () => void) => void): unknown {
    if (
      request.method === mobileReminderMethods.configure &&
      this.session.features.includes("reminders.apns") &&
      this.session.configureReminders
    ) {
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
    ) {
      return this.timeline.dispatch(request)
    }

    if (
      this.session.features.includes("changes.read") &&
      mobileRunChangesRequests.has(request.method)
    ) {
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
      this.session.features.includes("workbench.write") &&
      mobileWorkbenchWriteRequests.has(request.method)
    ) {
      this.requirePairedDevice()
      return this.workbenchWrite.dispatch(request)
    }

    if (
      this.session.features.includes("preview.tunnel") &&
      mobilePreviewRequests.has(request.method)
    ) {
      this.requirePairedDevice()
      return this.preview.dispatch(request)
    }

    if (this.session.features.includes("terminal") && mobileTerminalRequests.has(request.method)) {
      this.requirePairedDevice()
      return this.terminal.dispatch(request, onReply)
    }

    if (
      this.session.features.includes("projects.manage") &&
      mobileProjectRequests.has(request.method)
    ) {
      return this.projectManage.dispatch(request)
    }

    if (
      this.session.features.includes("agents.manage") &&
      mobileAgentRequests.has(request.method)
    ) {
      return this.agentManage.dispatch(request)
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
      return this.lookupReceipt(request.params, {
        canRun,
        canRespond,
        canDraft,
        canQueue,
        canAttachments,
      })
    }

    return UNHANDLED_MOBILE_REQUEST
  }

  private lookupReceipt(
    input: unknown,
    flags: {
      canRun: boolean
      canRespond: boolean
      canDraft: boolean
      canQueue: boolean
      canAttachments: boolean
    },
  ) {
    this.requirePairedDevice()
    const { commandId } = params(mobileReceiptParams, input)
    const receipt = this.receipts.lookup(commandId)
    if (!receipt) return {}
    const allowed =
      receipt.method === mobileDraftMethods.create
        ? flags.canDraft
        : queueRequestNames.has(receipt.method)
          ? flags.canQueue
          : mobileRunCommandRequests.has(receipt.method)
            ? flags.canRun
            : flags.canRespond
    if (!allowed) return {}
    requireMobileThread(this.ctx, receipt.threadId)
    if (!flags.canQueue && "queuedMessageId" in receipt) {
      return { receipt: legacyRunReceipt(receipt) }
    }
    if (!flags.canAttachments && "attachments" in receipt) {
      return { receipt: omitAttachments(receipt) }
    }
    return { receipt }
  }
}
