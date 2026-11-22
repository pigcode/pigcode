import type { QueueReceipt, QueueSnapshot, ThreadEvent } from "@pigcode/contracts"
import type { Context } from "cordis"
import { queueSourceAuthorized } from "../mobile/paired-devices"
import {
  QueuedMessageStore,
  type QueueDeviceSource,
  type StoredQueuedMessage,
} from "../storage/queued-message-store"
import type { QueuedRun } from "./run-queue"
import type { StartRunOptions } from "./service"

const messageLimit = 64
// A withdrawn message must fit in one mobile RPC reply even after JSON escaping.
const textLimit = 32_000

export type QueueErrorCode =
  | "QUEUE_MESSAGE_UNAVAILABLE"
  | "QUEUE_STALE_RUN"
  | "QUEUE_LIMIT"
  | "QUEUE_TEXT_TOO_LONG"
  | "DEVICE_REVOKED"

export class QueueOperationError extends Error {
  constructor(readonly code: QueueErrorCode) {
    super(code)
  }
}

type QueueEffect = Pick<QueueReceipt, "effect" | "messageId" | "runId" | "stoppedRunId" | "text">
type RecordEffect = (result: QueueEffect) => void

interface QueueGate {
  idle(threadId: string): boolean
  currentRun(threadId: string): string | undefined
}

declare module "cordis" {
  interface Context {
    messageQueue: MessageQueue
  }
}

export class MessageQueue {
  private readonly store: QueuedMessageStore
  private readonly scheduled = new Set<string>()
  private disposed = false

  constructor(
    private readonly ctx: Context,
    private readonly gate: QueueGate,
  ) {
    this.store = new QueuedMessageStore(ctx.storage.db)
    this.store.pauseOnRestart()
  }

  private accessible(threadId: string): boolean {
    const thread = this.ctx.threads.get(threadId)
    return thread != null && this.ctx.projects.list().some(({ id }) => id === thread.projectId)
  }

  private requireThread(threadId: string): void {
    if (!this.accessible(threadId)) throw new QueueOperationError("QUEUE_MESSAGE_UNAVAILABLE")
  }

  snapshot(threadId: string): QueueSnapshot {
    this.requireThread(threadId)
    const state = this.store.state(threadId)
    const messages = this.store.list(threadId)
    return {
      threadId,
      paused: messages.length > 0 && state.paused,
      activeRunId: this.gate.currentRun(threadId),
      messages: messages.map(({ id, text }) => ({
        id,
        text: text.length <= 200 ? text : text.slice(0, 199).replace(/[\uD800-\uDBFF]$/, "") + "…",
        selected: id === state.selectedId,
      })),
    }
  }

  canStartWithoutQueue(threadId: string): boolean {
    return this.gate.idle(threadId) && !this.store.list(threadId).length
  }

  async submit(
    threadId: string,
    text: string,
    options: StartRunOptions = {},
    emitLive?: QueuedRun["emitLive"],
  ) {
    this.requireThread(threadId)
    const { admission, ...savedOptions } = options
    if (admission?.isAuthorized && !admission.isAuthorized()) {
      throw new QueueOperationError("DEVICE_REVOKED")
    }
    const messages = this.store.list(threadId)
    if (this.gate.idle(threadId) && messages.length === 0) {
      const { runId } = await this.ctx.agents.startRun(threadId, text, emitLive, options)
      return { runId }
    }
    if (messages.length >= messageLimit) throw new QueueOperationError("QUEUE_LIMIT")
    if (text.length > textLimit) throw new QueueOperationError("QUEUE_TEXT_TOO_LONG")
    const source = admission?.deviceKey
      ? { deviceKey: admission.deviceKey, authorizationId: admission.authorizationId ?? "legacy" }
      : undefined
    const result = this.change(threadId, () => {
      const { id, runId } = this.store.add(threadId, text, savedOptions, source)
      admission?.recordReceipt(runId, id)
      return { runId, queuedMessageId: id }
    })
    this.schedule(threadId)
    return result
  }

  withdraw(threadId: string, messageId: string, record: RecordEffect): QueueEffect {
    this.requireThread(threadId)
    const queued = this.pending(threadId, messageId)
    return this.change(threadId, () => {
      this.store.remove(threadId, queued.id)
      const result: QueueEffect = { effect: "withdrawn", messageId, text: queued.text }
      record(result)
      return result
    })
  }

  stopAndSend(
    threadId: string,
    runId: string,
    messageId: string,
    record: RecordEffect,
    actionSource?: QueueDeviceSource,
  ): QueueEffect {
    this.requireThread(threadId)
    if (!this.authorized(actionSource)) throw new QueueOperationError("DEVICE_REVOKED")
    if (this.gate.currentRun(threadId) !== runId) throw new QueueOperationError("QUEUE_STALE_RUN")
    const queued = this.pending(threadId, messageId)
    if (this.store.state(threadId).selectedId)
      throw new QueueOperationError("QUEUE_MESSAGE_UNAVAILABLE")
    if (!this.authorized(queued.source)) throw new QueueOperationError("QUEUE_MESSAGE_UNAVAILABLE")
    const result: QueueEffect = {
      effect: "scheduled",
      messageId,
      runId: queued.runId,
      stoppedRunId: runId,
    }
    if (
      !this.ctx.agents.cancelRun(runId, () => {
        this.store.setState(threadId, false, queued.id, runId, actionSource)
        record(result)
        this.changed(threadId)
      })
    ) {
      throw new QueueOperationError("QUEUE_STALE_RUN")
    }
    this.schedule(threadId)
    return result
  }

  resume(threadId: string, record: RecordEffect, actionSource?: QueueDeviceSource): QueueEffect {
    this.requireThread(threadId)
    if (!this.authorized(actionSource)) throw new QueueOperationError("DEVICE_REVOKED")
    const paused = this.store.state(threadId).paused
    const head = this.store.list(threadId)[0]
    if (!paused || !head) {
      const result: QueueEffect = { effect: "unchanged" }
      record(result)
      return result
    }
    const result: QueueEffect = { effect: "resumed", messageId: head.id, runId: head.runId }
    this.change(threadId, () => {
      this.store.setState(threadId, false, null, null, actionSource)
      record(result)
    })
    this.schedule(threadId)
    return result
  }

  onRunEvent(threadId: string, runId: string | null, type: ThreadEvent["type"]): void {
    if (!runId || (type !== "run.completed" && type !== "run.interrupted" && type !== "run.failed"))
      return
    if (!this.store.list(threadId).length) return
    if (type !== "run.completed" && this.store.state(threadId).stopTargetId !== runId) {
      this.store.setState(threadId, true)
    }
    this.changed(threadId)
    this.schedule(threadId)
  }

  revoke(deviceKey: string): void {
    const affected = this.store.byDevice(deviceKey)
    const operations = this.store.actionsByDevice(deviceKey)
    if (!affected.length && !operations.length) return
    const publish = this.ctx.sessions.stageEvents(() => {
      const threads = new Set<string>()
      for (const queued of affected) {
        this.removeUnauthorized(queued)
        threads.add(queued.threadId)
      }
      for (const threadId of operations) {
        this.store.setState(threadId, this.store.list(threadId).length > 0)
        threads.add(threadId)
      }
      for (const threadId of threads) this.changed(threadId)
    })
    publish()
  }

  schedule(threadId: string): void {
    if (this.disposed || this.scheduled.has(threadId)) return
    this.scheduled.add(threadId)
    queueMicrotask(() => {
      this.scheduled.delete(threadId)
      void this.drain(threadId).catch((error) =>
        console.error("[host] queued message dispatch failed", error),
      )
    })
  }

  dispose(): void {
    this.disposed = true
  }

  private pending(threadId: string, id: string): StoredQueuedMessage {
    const state = this.store.state(threadId)
    const queued = this.store.list(threadId).find((item) => item.id === id)
    if (!queued || id === state.selectedId)
      throw new QueueOperationError("QUEUE_MESSAGE_UNAVAILABLE")
    return queued
  }

  private change<T>(threadId: string, mutate: () => T): T {
    let result!: T
    const publish = this.ctx.sessions.stageEvents(() => {
      result = mutate()
      this.changed(threadId)
    })
    publish()
    return result
  }

  private changed(threadId: string): void {
    this.ctx.sessions.append({
      threadId,
      runId: null,
      type: "queue.changed",
      payload: {},
      schemaVersion: 1,
      createdAt: new Date().toISOString(),
    })
  }

  private authorized(source?: QueueDeviceSource): boolean {
    return !source || queueSourceAuthorized(this.ctx.get("settings"), source)
  }

  private removeUnauthorized(queued: StoredQueuedMessage): void {
    const wasSelected = this.store.state(queued.threadId).selectedId === queued.id
    this.store.remove(queued.threadId, queued.id)
    if (wasSelected) {
      this.store.setState(queued.threadId, this.store.list(queued.threadId).length > 0)
    }
  }

  private async drain(threadId: string): Promise<void> {
    if (this.disposed || !this.gate.idle(threadId) || !this.accessible(threadId)) return
    const state = this.store.state(threadId)
    if (state.paused) return
    if (!this.authorized(state.actionSource)) {
      this.change(threadId, () => this.store.setState(threadId, true))
      return
    }
    const messages = this.store.list(threadId)
    const next = state.selectedId ? messages.find(({ id }) => id === state.selectedId) : messages[0]
    if (!next) return
    if (!this.authorized(next.source)) {
      this.change(threadId, () => this.removeUnauthorized(next))
      this.schedule(threadId)
      return
    }

    try {
      await this.ctx.agents.startRun(threadId, next.text, undefined, {
        ...next.options,
        admission: {
          runId: next.runId,
          ...(next.source ? { deviceKey: next.source.deviceKey } : {}),
          isAuthorized: () => this.authorized(next.source) && this.authorized(state.actionSource),
          recordReceipt: () => {
            if (!this.store.remove(threadId, next.id))
              throw new QueueOperationError("QUEUE_MESSAGE_UNAVAILABLE")
            if (state.selectedId === next.id || state.actionSource)
              this.store.setState(threadId, false)
            this.changed(threadId)
          },
        },
      })
    } catch (error) {
      if (this.store.list(threadId).some(({ id }) => id === next.id)) {
        this.change(threadId, () => this.store.setState(threadId, true))
      }
      throw error
    }
  }
}
