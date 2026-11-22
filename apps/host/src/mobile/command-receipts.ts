import { createHash } from "node:crypto"
import { mobileRequestReceipt, mobileRunReceipt } from "@pigcode/contracts"
import type { Context } from "cordis"
import { z } from "zod"
import type { ReceiptStore } from "../storage/receipt-store"
import { MobileRequestError } from "./request-error"

const receiptSchema = z.union([mobileRunReceipt, mobileRequestReceipt])
const storedReceipt = z.strictObject({ binding: z.string(), receipt: receiptSchema })
type Receipt = z.infer<typeof receiptSchema>

export function commandBinding(...parts: unknown[]): string {
  return createHash("sha256").update(JSON.stringify(parts)).digest("hex")
}

export function mobileThreadAvailable(ctx: Context, threadId: string): boolean {
  const thread = ctx.threads.get(threadId)
  return (
    !!thread &&
    !thread.parentThreadId &&
    ctx.projects.list().some(({ id }) => id === thread.projectId)
  )
}

export function requireMobileThread(ctx: Context, threadId: string): void {
  if (!mobileThreadAvailable(ctx, threadId)) {
    throw new MobileRequestError("RESOURCE_NOT_AVAILABLE")
  }
}

/** Same receipt namespace for every command submitted by a paired installation. */
export class MobileCommandReceipts {
  constructor(
    private readonly store: ReceiptStore,
    private readonly deviceKey: string,
  ) {}

  private key(commandId: string): string {
    return "mobile:v1:" + this.deviceKey + ":" + commandId
  }

  private read(commandId: string) {
    const value = this.store.get(this.key(commandId))
    return value === undefined ? undefined : storedReceipt.parse(value)
  }

  lookup(commandId: string): Receipt | undefined {
    return this.read(commandId)?.receipt
  }

  existing<T>(commandId: string, binding: string, schema: z.ZodType<T>): T | undefined {
    const previous = this.read(commandId)
    if (!previous) return undefined
    if (previous.binding !== binding) throw new MobileRequestError("COMMAND_ID_CONFLICT")
    return schema.parse(previous.receipt)
  }

  record(receipt: Receipt, binding: string): void {
    this.store.insert(this.key(receipt.commandId), { binding, receipt })
  }
}
