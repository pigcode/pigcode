import { createHash } from "node:crypto"
import {
  mobileCommandMethods as methods,
  mobileInterruptRunParams,
  mobileReceiptParams,
  mobileRunReceipt,
  mobileStartRunParams,
  type MobileInterruptRunParams,
  type MobileRunReceipt,
  type MobileStartRunParams,
  type RpcRequest,
} from "@pigcode/contracts"
import type { Context } from "cordis"
import { z } from "zod"
import { RunAlreadyActiveError, RunQueueFullError } from "../agents/errors"
import { RunStore } from "../storage/run-store"
import type { PairedDevices } from "./paired-devices"
import { mobileParams, MobileRequestError } from "./request-error"

export const mobileRunCommandRequests: ReadonlySet<string> = new Set(Object.values(methods))
const storedReceipt = z.strictObject({ binding: z.string(), receipt: mobileRunReceipt })
const terminal = new Set(["completed", "interrupted", "failed"])

export class MobileRunCommands {
  private readonly runs: RunStore

  constructor(
    private readonly ctx: Context,
    private readonly devices: PairedDevices,
    private readonly deviceKey: string,
  ) {
    this.runs = new RunStore(ctx.storage.db)
  }

  dispatch(request: RpcRequest): unknown {
    if (!this.devices.find(this.deviceKey)) throw new MobileRequestError("DEVICE_REVOKED")
    switch (request.method) {
      case methods.start:
        return this.start(mobileParams(mobileStartRunParams, request.params))
      case methods.interrupt:
        return this.interrupt(mobileParams(mobileInterruptRunParams, request.params))
      case methods.receipt: {
        const { commandId } = mobileParams(mobileReceiptParams, request.params)
        const receipt = this.read(commandId)?.receipt
        if (receipt) this.requireThread(receipt.threadId)
        return receipt ? { receipt } : {}
      }
      default:
        throw new MobileRequestError("METHOD_NOT_AVAILABLE")
    }
  }

  private async start({
    commandId,
    threadId,
    text,
  }: MobileStartRunParams): Promise<MobileRunReceipt> {
    this.requireThread(threadId)
    const binding = this.binding(methods.start, threadId, text)
    const previous = this.existing(commandId, binding)
    if (previous) return previous

    try {
      const { runId } = await this.ctx.agents.startRun(threadId, text, undefined, {
        mobileAdmission: {
          deviceKey: this.deviceKey,
          isAuthorized: this.devices.runAuthorization(this.deviceKey),
          recordReceipt: (runId) => {
            this.record({ commandId, method: methods.start, threadId, runId }, binding)
          },
        },
      })
      return { commandId, method: methods.start, threadId, runId }
    } catch (error) {
      const accepted = this.existing(commandId, binding)
      if (accepted) return accepted
      if (error instanceof RunAlreadyActiveError) throw new MobileRequestError("THREAD_BUSY")
      if (error instanceof RunQueueFullError) throw new MobileRequestError("RUN_QUEUE_FULL")
      throw error
    }
  }

  private interrupt({ commandId, threadId, runId }: MobileInterruptRunParams): MobileRunReceipt {
    this.requireThread(threadId)
    const binding = this.binding(methods.interrupt, threadId, runId)
    const previous = this.existing(commandId, binding)
    if (previous) return previous

    const run = this.runs.get(runId)
    if (!run || run.threadId !== threadId) throw new MobileRequestError("RESOURCE_NOT_AVAILABLE")
    const receipt = { commandId, method: methods.interrupt, threadId, runId } as const
    try {
      const record = () => this.record(receipt, binding)
      if (terminal.has(run.status)) record()
      else if (!this.ctx.agents.cancelRun(runId, record)) throw new Error("Run is unavailable")
    } catch (error) {
      const accepted = this.existing(commandId, binding)
      if (accepted) return accepted
      throw error
    }
    return receipt
  }

  private requireThread(threadId: string): void {
    const thread = this.ctx.threads.get(threadId)
    if (
      !thread ||
      thread.parentThreadId ||
      !this.ctx.projects.list().some(({ id }) => id === thread.projectId)
    ) {
      throw new MobileRequestError("RESOURCE_NOT_AVAILABLE")
    }
  }

  private key(commandId: string): string {
    return "mobile:v1:" + this.deviceKey + ":" + commandId
  }

  private binding(method: string, threadId: string, argument: string): string {
    return createHash("sha256")
      .update(JSON.stringify([method, threadId, argument]))
      .digest("hex")
  }

  private read(commandId: string) {
    const value = this.ctx.storage.receipts.get(this.key(commandId))
    return value === undefined ? undefined : storedReceipt.parse(value)
  }

  private existing(commandId: string, binding: string): MobileRunReceipt | undefined {
    const previous = this.read(commandId)
    if (previous && previous.binding !== binding)
      throw new MobileRequestError("COMMAND_ID_CONFLICT")
    return previous?.receipt
  }

  private record(receipt: MobileRunReceipt, binding: string): void {
    this.ctx.storage.receipts.insert(this.key(receipt.commandId), { binding, receipt })
  }
}
