import {
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
import { RunStore } from "../storage/run-store"
import { commandBinding, requireMobileThread, type MobileCommandReceipts } from "./command-receipts"
import type { PairedDevices } from "./paired-devices"
import { mobileParams, MobileRequestError } from "./request-error"

export const mobileRunCommandRequests: ReadonlySet<string> = new Set([
  methods.start,
  methods.interrupt,
])
const terminal = new Set(["completed", "interrupted", "failed"])

export class MobileRunCommands {
  private readonly runs: RunStore

  constructor(
    private readonly ctx: Context,
    private readonly devices: PairedDevices,
    private readonly deviceKey: string,
    private readonly receipts: MobileCommandReceipts,
  ) {
    this.runs = new RunStore(ctx.storage.db)
  }

  dispatch(request: RpcRequest): unknown {
    switch (request.method) {
      case methods.start:
        return this.start(mobileParams(mobileStartRunParams, request.params))
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
  }: MobileStartRunParams): Promise<MobileRunReceipt> {
    requireMobileThread(this.ctx, threadId)
    const binding = commandBinding(methods.start, threadId, text)
    const previous = this.receipts.existing(commandId, binding, mobileRunReceipt)
    if (previous) return previous

    try {
      const { runId } = await this.ctx.agents.startRun(threadId, text, undefined, {
        mobileAdmission: {
          deviceKey: this.deviceKey,
          isAuthorized: this.devices.runAuthorization(this.deviceKey),
          recordReceipt: (runId) => {
            this.receipts.record({ commandId, method: methods.start, threadId, runId }, binding)
          },
        },
      })
      return { commandId, method: methods.start, threadId, runId }
    } catch (error) {
      const accepted = this.receipts.existing(commandId, binding, mobileRunReceipt)
      if (accepted) return accepted
      if (error instanceof RunAlreadyActiveError) throw new MobileRequestError("THREAD_BUSY")
      if (error instanceof RunQueueFullError) throw new MobileRequestError("RUN_QUEUE_FULL")
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
