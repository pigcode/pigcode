import { useSyncExternalStore } from "react"
import type { Connection } from "@pigcode/client-runtime"
import {
  isHostErrorCode,
  mobileRunReceipt,
  queueReceipt,
  type QueueReceipt,
} from "@pigcode/contracts"
import { appendComposerText, captureComposerDraft } from "@pigcode/ui-composer"

type SendOptions = NonNullable<Parameters<Connection["startRun"]>[2]>
type SendConnection = Pick<Connection, "startRun" | "call">

interface PendingSend {
  threadId: string
  text: string
  commandId: string
  options: SendOptions
  restore(): void
}

export interface DesktopQueueOperation {
  method: QueueReceipt["method"]
  commandId: string
  threadId: string
  messageId?: string
  runId?: string
}

type PendingAction = DesktopQueueOperation & { working: boolean }

let pending: readonly PendingSend[] = []
let actions: readonly PendingAction[] = []
const listeners = new Set<() => void>()
const recovering = new Set<string>()

function observe(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

function update(next: readonly PendingSend[]) {
  pending = next
  for (const listener of listeners) listener()
}

export function usePendingDesktopSends(): readonly PendingSend[] {
  return useSyncExternalStore(observe, () => pending)
}

export function usePendingDesktopQueueActions(): readonly PendingAction[] {
  return useSyncExternalStore(observe, () => actions)
}

function updateActions(next: readonly PendingAction[]) {
  actions = next
  for (const listener of listeners) listener()
}

function definitive(error: unknown): boolean {
  return error instanceof Object && "code" in error && isHostErrorCode(error.code)
}

export async function submitDesktopMessage(
  connection: SendConnection,
  threadId: string,
  text: string,
  options: SendOptions,
  fail: (error: unknown) => void,
): Promise<void> {
  const restoreDraft = captureComposerDraft(threadId)
  if (pending.some((submission) => submission.threadId === threadId)) {
    queueMicrotask(() => restoreDraft(threadId))
    return
  }
  const commandId = crypto.randomUUID()
  const send: PendingSend = {
    threadId,
    text,
    commandId,
    options: { ...options, commandId },
    restore: () => restoreDraft(threadId),
  }
  try {
    await connection.startRun(threadId, text, send.options)
  } catch (error) {
    if (definitive(error)) {
      send.restore()
      fail(error)
      return
    }
    update([...pending, send])
  }
}

export async function recoverDesktopSend(
  connection: SendConnection,
  send: PendingSend,
  retry: boolean,
  fail: (error: unknown) => void,
): Promise<void> {
  if (recovering.has(send.commandId) || !pending.includes(send)) return
  recovering.add(send.commandId)
  try {
    const value = await connection.call("command.receipt", { commandId: send.commandId })
    const raw = (value as { receipt?: unknown } | null)?.receipt
    if (raw != null) {
      const receipt = mobileRunReceipt.parse(raw)
      if (
        receipt.commandId !== send.commandId ||
        receipt.threadId !== send.threadId ||
        receipt.method !== "run.start"
      ) {
        throw new Error("Unexpected send receipt")
      }
    } else if (retry) {
      await connection.startRun(send.threadId, send.text, send.options)
    } else {
      return
    }
    update(pending.filter((item) => item !== send))
  } catch (error) {
    if (retry && definitive(error)) {
      update(pending.filter((item) => item !== send))
      send.restore()
      fail(error)
    }
  } finally {
    recovering.delete(send.commandId)
  }
}

export async function performDesktopQueueAction(
  connection: Pick<Connection, "call">,
  operation: DesktopQueueOperation,
  mode: "submit" | "check" | "retry",
  fail: (error: unknown) => void,
): Promise<void> {
  const current = actions.find(({ threadId }) => threadId === operation.threadId)
  if (
    mode === "submit"
      ? current != null
      : current?.commandId !== operation.commandId || current.working
  )
    return
  const { commandId, threadId, method } = operation
  const params = {
    commandId,
    threadId,
    ...(operation.messageId ? { messageId: operation.messageId } : {}),
    ...(operation.runId ? { runId: operation.runId } : {}),
  }
  updateActions([
    ...actions.filter((item) => item.commandId !== commandId),
    { ...operation, working: true },
  ])
  try {
    let value: unknown
    if (mode !== "submit") {
      const reply = (await connection.call("command.receipt", { commandId })) as {
        receipt?: unknown
      }
      value = reply.receipt
      if (value == null && mode === "check") return
    }
    value ??= await connection.call(method, params)
    const result = queueReceipt.parse(value)
    if (
      result.commandId !== commandId ||
      result.threadId !== threadId ||
      result.method !== method ||
      (operation.messageId !== undefined && result.messageId !== operation.messageId)
    ) {
      throw new Error("Unexpected queue receipt")
    }
    if (result.effect === "withdrawn" && (result.text || result.attachments?.length)) {
      appendComposerText(threadId, result.text ?? "", result.attachments)
    }
    updateActions(actions.filter((item) => item.commandId !== commandId))
  } catch (error) {
    if (definitive(error)) {
      updateActions(actions.filter((item) => item.commandId !== commandId))
      fail(error)
    }
  } finally {
    if (actions.some((item) => item.commandId === commandId)) {
      updateActions(
        actions.map((item) => (item.commandId === commandId ? { ...item, working: false } : item)),
      )
    }
  }
}

export async function checkDesktopQueueAfterReconnect(
  connection: Pick<Connection, "call">,
  threadId: string,
  fail: (error: unknown) => void,
): Promise<void> {
  const action = actions.find((item) => item.threadId === threadId)
  if (action) await performDesktopQueueAction(connection, action, "check", fail)
}
