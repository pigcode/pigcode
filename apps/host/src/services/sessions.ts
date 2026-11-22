/** 管理线程事件日志与实时订阅；delta 不落库，只走实时通道。 */
import type { Context } from "cordis"
import type { ThreadEvent } from "@pigcode/contracts"
import type { NewThreadEvent } from "../storage/event-store"
import { RunStreams, type LiveAgentDelta, type LiveRunRecord, type RunDelta } from "./run-streams"

/** 线程事件的追加、回读与实时订阅入口。 */
export interface SessionsService {
  append(event: NewThreadEvent): ThreadEvent
  read(threadId: string, cursor: number): ThreadEvent[]
  latestSeq(threadId: string): number
  readBefore(
    threadId: string,
    through: number,
    before: number,
    limit: number,
  ): Iterable<ThreadEvent>
  get(threadId: string, seq: number): ThreadEvent | undefined
  emitLive(threadId: string, runId: string, event: LiveAgentDelta): void
  liveSnapshot(threadId: string): LiveRunRecord | undefined
  subscribeLive(threadId: string, listener: (event: RunDelta) => void): () => void
  subscribe(threadId: string, listener: (event: ThreadEvent) => void): () => void
  /** 监听所有线程的事件，供 checkpoint 等跨线程服务使用。 */
  subscribeAll(listener: (event: ThreadEvent) => void): () => void
}

declare module "cordis" {
  interface Context {
    sessions: SessionsService
  }
}

/** sessions 插件依赖的 storage 服务。 */
export const inject = ["storage"]

/** sessions 插件函数，携带 Cordis 需要的 inject 元数据。 */
export interface SessionsPlugin {
  (ctx: Context): void
  inject: string[]
}

/** 注册 sessions 服务；追加事件后通知该线程的订阅者。 */
export const apply: SessionsPlugin = (ctx) => {
  const listeners = new Map<string, Set<(event: ThreadEvent) => void>>()
  const globalListeners = new Set<(event: ThreadEvent) => void>()
  const streams = new RunStreams()
  const service: SessionsService = {
    append(event) {
      const stored = ctx.storage.events.append(event)
      streams.record(stored)
      // 复制监听器集合，允许回调在广播期间追加事件或取消订阅。
      for (const listener of [...(listeners.get(event.threadId) ?? [])]) listener(stored)
      for (const listener of [...globalListeners]) listener(stored)
      return stored
    },
    read(threadId, cursor) {
      return ctx.storage.events.read(threadId, cursor)
    },
    latestSeq(threadId) {
      return ctx.storage.events.latestSeq(threadId)
    },
    readBefore(threadId, through, before, limit) {
      return ctx.storage.events.readBefore(threadId, through, before, limit)
    },
    get(threadId, seq) {
      return ctx.storage.events.get(threadId, seq)
    },
    emitLive(threadId, runId, event) {
      streams.emit(threadId, runId, event)
    },
    liveSnapshot(threadId) {
      return streams.snapshot(threadId)
    },
    subscribeLive(threadId, listener) {
      return streams.subscribe(threadId, listener)
    },
    subscribe(threadId, listener) {
      const set = listeners.get(threadId) ?? new Set()
      set.add(listener)
      listeners.set(threadId, set)
      return () => {
        set.delete(listener)
        if (set.size === 0) listeners.delete(threadId)
      }
    },
    subscribeAll(listener) {
      globalListeners.add(listener)
      return () => {
        globalListeners.delete(listener)
      }
    },
  }
  ctx.provide("sessions", service)
  ctx.effect(() => () => {
    listeners.clear()
    globalListeners.clear()
    streams.clear()
  })
}

apply.inject = inject
