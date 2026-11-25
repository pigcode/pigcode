import {
  mobileReceiptParams,
  mobileRunReceipt,
  queueMethods,
  queueReceipt,
  queueResumeParams,
  queueStopAndSendParams,
  queueThreadParams,
  queueWithdrawParams,
  type CommandParams,
  type QueueReceipt,
} from "@pigcode/contracts"
import type { Context } from "cordis"
import type { QueuedRun } from "../agents/run-queue"
import { CommandReceipts, commandBinding } from "../mobile/command-receipts"
import { mobileParams } from "../mobile/request-error"
import type { QueueDeviceSource } from "../storage/queued-message-store"

export const queueRequestNames: ReadonlySet<string> = new Set(Object.values(queueMethods))
export const desktopQueueRequests: ReadonlySet<string> = new Set([
  ...queueRequestNames,
  "run.start",
  "command.receipt",
])

export function dispatchQueuedMessage(
  ctx: Context,
  receipts: CommandReceipts,
  method: string,
  input: unknown,
  requireThread?: (threadId: string) => void,
  actionSource?: QueueDeviceSource,
) {
  if (method === queueMethods.get) {
    const { threadId } = mobileParams(queueThreadParams, input)
    requireThread?.(threadId)
    return ctx.messageQueue.snapshot(threadId)
  }

  type Effect = Omit<QueueReceipt, "method" | "threadId" | "commandId">
  const apply = (
    action: QueueReceipt["method"],
    params: { commandId: string; threadId: string },
    execute: (record: (effect: Effect) => void) => Effect,
  ) => {
    const { commandId, threadId } = params
    requireThread?.(threadId)
    const binding = commandBinding(action, params)
    const previous = receipts.existing(commandId, binding, queueReceipt)
    if (previous) return previous
    const receiptOf = (effect: Effect) => ({ method: action, commandId, threadId, ...effect })
    return receiptOf(execute((effect) => receipts.record(receiptOf(effect), binding)))
  }

  switch (method) {
    case queueMethods.withdraw: {
      const params = mobileParams(queueWithdrawParams, input)
      return apply(method, params, (record) =>
        ctx.messageQueue.withdraw(params.threadId, params.messageId, record),
      )
    }
    case queueMethods.stopAndSend: {
      const params = mobileParams(queueStopAndSendParams, input)
      return apply(method, params, (record) =>
        ctx.messageQueue.stopAndSend(
          params.threadId,
          params.runId,
          params.messageId,
          record,
          actionSource,
        ),
      )
    }
    case queueMethods.resume: {
      const params = mobileParams(queueResumeParams, input)
      return apply(method, params, (record) =>
        ctx.messageQueue.resume(params.threadId, record, actionSource),
      )
    }
    default:
      throw new Error("unknown queue command")
  }
}

export async function dispatchDesktopQueue(
  ctx: Context,
  method: string,
  parsed: unknown,
  changed: (threadId: string) => void,
  emitLive: (threadId: string, event: Parameters<NonNullable<QueuedRun["emitLive"]>>[0]) => void,
) {
  const receipts = new CommandReceipts(ctx.storage.receipts, "desktop:v1:")
  if (method === "command.receipt") {
    const { commandId } = mobileParams(mobileReceiptParams, parsed)
    const receipt = receipts.lookup(commandId)
    return receipt ? { receipt } : {}
  }
  if (method !== "run.start") return dispatchQueuedMessage(ctx, receipts, method, parsed)

  const {
    threadId,
    commandId,
    text,
    effort,
    fast,
    ultracode,
    instanceId,
    references,
    attachmentIds,
  } = parsed as CommandParams<"run.start">
  const options = {
    ...(effort ? { effort } : {}),
    ...(fast ? { fast: true } : {}),
    ...(ultracode ? { ultracode: true } : {}),
    ...(instanceId ? { instanceId } : {}),
    ...(references ? { references } : {}),
    ...(attachmentIds && attachmentIds.length > 0 ? { attachmentIds } : {}),
  }
  const binding = commandBinding(method, threadId, text, options)
  const prior = commandId ? receipts.existing(commandId, binding, mobileRunReceipt) : undefined
  if (prior) return prior
  if (ctx.threads.get(threadId)?.archivedAt) {
    ctx.threads.unarchive(threadId)
    changed(threadId)
  }
  const emit = (event: Parameters<NonNullable<QueuedRun["emitLive"]>>[0]) =>
    emitLive(threadId, event)
  if (!commandId) return ctx.messageQueue.submit(threadId, text, options, emit)
  try {
    await ctx.messageQueue.submit(
      threadId,
      text,
      {
        ...options,
        admission: {
          recordReceipt: (runId, queuedMessageId) =>
            receipts.record(
              {
                method,
                commandId,
                threadId,
                runId,
                ...(queuedMessageId ? { queuedMessageId } : {}),
              },
              binding,
            ),
        },
      },
      emit,
    )
  } catch (error) {
    const accepted = receipts.existing(commandId, binding, mobileRunReceipt)
    if (accepted) return accepted
    throw error
  }
  return receipts.existing(commandId, binding, mobileRunReceipt)
}
