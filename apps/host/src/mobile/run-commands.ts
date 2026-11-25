import {
  legacyMobileStartRunParams,
  mobileCommandMethods as methods,
  mobileInterruptRunParams,
  mobileRunReceipt,
  mobileStartRunParams,
  type MobileInterruptRunParams,
  type MobileRunReceipt,
  type MobileStartRunParams,
  type RpcRequest,
} from "@pigcode/contracts"
import type { Context } from "cordis"
import { RunAlreadyActiveError, RunQueueFullError } from "../agents/errors"
import { QueueOperationError } from "../agents/message-queue"
import { RunStore } from "../storage/run-store"
import { commandBinding, requireMobileThread, type MobileCommandReceipts } from "./command-receipts"
import type { PairedDevices } from "./paired-devices"
import { mobileParams, MobileRequestError } from "./request-error"

export const mobileRunCommandRequests: ReadonlySet<string> = new Set([
  methods.start,
  methods.interrupt,
])
const terminal = new Set(["completed", "interrupted", "failed"])

export function legacyRunReceipt({ method, commandId, threadId, runId }: MobileRunReceipt) {
  return { method, commandId, threadId, runId }
}

export class MobileRunCommands {
  private readonly runs: RunStore

  constructor(
    private readonly ctx: Context,
    private readonly devices: PairedDevices,
    private readonly deviceKey: string,
    private readonly receipts: MobileCommandReceipts,
    private readonly supportsQueue: boolean,
    private readonly supportsComposerControls = false,
  ) {
    this.runs = new RunStore(ctx.storage.db)
  }

  dispatch(request: RpcRequest): unknown {
    switch (request.method) {
      case methods.start:
        return this.start(
          mobileParams(
            this.supportsComposerControls ? mobileStartRunParams : legacyMobileStartRunParams,
            request.params,
          ),
        )
      case methods.interrupt:
        return this.interrupt(mobileParams(mobileInterruptRunParams, request.params))
      default:
        throw new MobileRequestError("METHOD_NOT_AVAILABLE")
    }
  }

  private async start({
    commandId,
    threadId,
    text,
    effort,
    fast,
    ultracode,
    references,
  }: MobileStartRunParams): Promise<MobileRunReceipt> {
    requireMobileThread(this.ctx, threadId)
    if (references) {
      for (const reference of references) requireMobileThread(this.ctx, reference.threadId)
    }
    const extras: Record<string, unknown> = {}
    if (effort !== undefined) extras.effort = effort
    if (fast !== undefined) extras.fast = fast
    if (ultracode !== undefined) extras.ultracode = ultracode
    if (references !== undefined) extras.references = references
    const binding =
      Object.keys(extras).length > 0
        ? commandBinding(methods.start, threadId, text, extras)
        : commandBinding(methods.start, threadId, text)
    const previous = this.receipts.existing(commandId, binding, mobileRunReceipt)
    if (previous) return this.supportsQueue ? previous : legacyRunReceipt(previous)
    if (!this.supportsQueue && !this.ctx.messageQueue.canStartWithoutQueue(threadId)) {
      throw new MobileRequestError("THREAD_BUSY")
    }

    try {
      const source = this.devices.queueSource(this.deviceKey)
      const options = {
        ...(effort ? { effort } : {}),
        ...(fast ? { fast: true } : {}),
        ...(ultracode ? { ultracode: true } : {}),
        ...(references && references.length > 0
          ? {
              references: references.map(({ kind, threadId: refThreadId }) => ({
                kind,
                threadId: refThreadId,
              })),
            }
          : {}),
        admission: {
          deviceKey: this.deviceKey,
          ...(source ? { authorizationId: source.authorizationId } : {}),
          isAuthorized: this.devices.runAuthorization(this.deviceKey),
          recordReceipt: (runId: string, queuedMessageId?: string) => {
            this.receipts.record(
              {
                commandId,
                method: methods.start,
                threadId,
                runId,
                ...(queuedMessageId ? { queuedMessageId } : {}),
              },
              binding,
            )
          },
        },
      }
      const result = this.supportsQueue
        ? await this.ctx.messageQueue.submit(threadId, text, options)
        : await this.ctx.agents.startRun(threadId, text, undefined, options)
      return (
        this.receipts.existing(commandId, binding, mobileRunReceipt) ?? {
          commandId,
          method: methods.start,
          threadId,
          runId: result.runId,
        }
      )
    } catch (error) {
      const accepted = this.receipts.existing(commandId, binding, mobileRunReceipt)
      if (accepted) return this.supportsQueue ? accepted : legacyRunReceipt(accepted)
      if (error instanceof RunAlreadyActiveError) throw new MobileRequestError("THREAD_BUSY")
      if (error instanceof RunQueueFullError) throw new MobileRequestError("RUN_QUEUE_FULL")
      if (error instanceof QueueOperationError) throw new MobileRequestError(error.code)
      throw error
    }
  }

  private interrupt({ commandId, threadId, runId }: MobileInterruptRunParams): MobileRunReceipt {
    requireMobileThread(this.ctx, threadId)
    const binding = commandBinding(methods.interrupt, threadId, runId)
    const previous = this.receipts.existing(commandId, binding, mobileRunReceipt)
    if (previous) return previous

    const run = this.runs.get(runId)
    if (!run || run.threadId !== threadId) throw new MobileRequestError("RESOURCE_NOT_AVAILABLE")
    const receipt = { commandId, method: methods.interrupt, threadId, runId } as const
    try {
      const record = () => this.receipts.record(receipt, binding)
      if (terminal.has(run.status)) record()
      else if (!this.ctx.agents.cancelRun(runId, record)) throw new Error("Run is unavailable")
    } catch (error) {
      const accepted = this.receipts.existing(commandId, binding, mobileRunReceipt)
      if (accepted) return accepted
      throw error
    }
    return receipt
  }
}
