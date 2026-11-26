/** 手机端远程终端 RPC 与流式推送控制器：归属隔离（电脑只读/手机可写）、有序分片回放、16ms 合并与背压保护。 */
import { basename } from "node:path"
import {
  MOBILE_TERMINAL_COALESCE_MS,
  MOBILE_TERMINAL_MAX_PENDING_BYTES,
  MOBILE_TERMINAL_MAX_PER_THREAD,
  MOBILE_TERMINAL_OUTPUT_CHUNK_BYTES,
  mobileTerminalAttachParams,
  mobileTerminalAttachResult,
  mobileTerminalCloseParams,
  mobileTerminalCloseResult,
  mobileTerminalDetachParams,
  mobileTerminalDetachResult,
  mobileTerminalExitNotification,
  mobileTerminalListParams,
  mobileTerminalListResult,
  mobileTerminalMethods as methods,
  mobileTerminalNotifications as notifications,
  mobileTerminalOpenParams,
  mobileTerminalOpenResult,
  mobileTerminalOutputNotification,
  mobileTerminalResizeParams,
  mobileTerminalResizeResult,
  mobileTerminalSummarySchema,
  mobileTerminalWriteParams,
  mobileTerminalWriteResult,
  type MobileTerminalAttachParams,
  type MobileTerminalAttachResult,
  type MobileTerminalCloseParams,
  type MobileTerminalCloseResult,
  type MobileTerminalDetachParams,
  type MobileTerminalDetachResult,
  type MobileTerminalListParams,
  type MobileTerminalListResult,
  type MobileTerminalOpenParams,
  type MobileTerminalOpenResult,
  type MobileTerminalResizeParams,
  type MobileTerminalResizeResult,
  type MobileTerminalSummary,
  type MobileTerminalWriteParams,
  type MobileTerminalWriteResult,
  type RpcRequest,
} from "@pigcode/contracts"
import type { Context } from "cordis"
import type { TerminalService, TerminalSession } from "../services/terminal"
import { requireMobileThread } from "./command-receipts"
import { mobileParams, MobileRequestError } from "./request-error"

export const mobileTerminalRequests: ReadonlySet<string> = new Set(Object.values(methods))

export interface MobileTerminalOptions {
  outputChunkBytes?: number
  coalesceMs?: number
  maxPendingBytes?: number
  maxPerThread?: number
}

interface ActiveSubscription {
  terminalId: string
  start(): void
  dispose(): void
}

const sessionRegistries = new WeakMap<Context, Set<MobileTerminalSession>>()

function registryFor(ctx: Context): Set<MobileTerminalSession> {
  let set = sessionRegistries.get(ctx)
  if (!set) {
    set = new Set()
    sessionRegistries.set(ctx, set)
  }
  return set
}

/** 撤销某部配对设备时，立即终止该设备的全部手机终端订阅并清理定时器（不关闭任何电脑 PTY）。 */
export function cleanupDeviceMobileTerminals(ctx: Context, deviceKey: string): void {
  const set = sessionRegistries.get(ctx)
  if (!set) return
  for (const session of [...set]) {
    if (session.deviceKey === deviceKey) {
      session.close()
    }
  }
}

function isHighSurrogate(code: number): boolean {
  return code >= 0xd800 && code <= 0xdbff
}

function isLowSurrogate(code: number): boolean {
  return code >= 0xdc00 && code <= 0xdfff
}

/** 按 UTF-8 字节上限切分文本，绝不切裂 UTF-16 代理对，同时计算每片精确的单调 UTF-16 游标。 */
export function sliceUtf8Chunks(
  text: string,
  endCursor: number,
  maxBytes: number,
): Array<{ text: string; cursor: number }> {
  if (text.length === 0) return []
  const limit = Math.max(4, maxBytes)
  const baseCursor = endCursor - text.length
  const out: Array<{ text: string; cursor: number }> = []
  let chunkStart = 0
  let chunkBytes = 0
  let i = 0

  while (i < text.length) {
    const code = text.charCodeAt(i)
    let stepUnits = 1
    let stepBytes: number
    if (isHighSurrogate(code) && i + 1 < text.length && isLowSurrogate(text.charCodeAt(i + 1))) {
      stepUnits = 2
      stepBytes = 4
    } else if (code <= 0x7f) {
      stepBytes = 1
    } else if (code <= 0x7ff) {
      stepBytes = 2
    } else {
      stepBytes = 3
    }

    if (chunkBytes + stepBytes > limit && i > chunkStart) {
      out.push({ text: text.slice(chunkStart, i), cursor: baseCursor + i })
      chunkStart = i
      chunkBytes = 0
    }
    chunkBytes += stepBytes
    i += stepUnits
  }

  if (chunkStart < text.length) {
    out.push({ text: text.slice(chunkStart), cursor: endCursor })
  }
  return out
}

function safeCwdLabel(cwd: string): string {
  const name = basename(cwd.replaceAll("\\", "/")).trim()
  return (name.length > 0 ? name : "workspace").slice(0, 120)
}

function toMobileSummary(session: TerminalSession): MobileTerminalSummary {
  return mobileTerminalSummarySchema.parse({
    id: session.id,
    threadId: session.threadId ?? "",
    shell: session.shell.slice(0, 80) || "shell",
    cwdLabel: safeCwdLabel(session.cwd),
    cols: session.cols,
    rows: session.rows,
    cursor: session.cursor,
    origin: session.origin,
    writable: session.origin === "mobile",
    createdAt: session.createdAt,
  })
}

export class MobileTerminalSession {
  private readonly subscriptions = new Map<string, ActiveSubscription>()
  private readonly outputChunkBytes: number
  private readonly coalesceMs: number
  private readonly maxPendingBytes: number
  private readonly maxPerThread: number
  private closed = false

  constructor(
    private readonly ctx: Context,
    readonly deviceKey: string,
    private readonly send: (message: unknown) => void,
    private readonly requirePairedDevice: () => void,
    options?: MobileTerminalOptions,
  ) {
    this.outputChunkBytes = options?.outputChunkBytes ?? MOBILE_TERMINAL_OUTPUT_CHUNK_BYTES
    this.coalesceMs = options?.coalesceMs ?? MOBILE_TERMINAL_COALESCE_MS
    this.maxPendingBytes = options?.maxPendingBytes ?? MOBILE_TERMINAL_MAX_PENDING_BYTES
    this.maxPerThread = options?.maxPerThread ?? MOBILE_TERMINAL_MAX_PER_THREAD
    registryFor(ctx).add(this)
  }

  /** 仅释放当前连接上的所有订阅与定时器，不关闭任何电脑端 PTY（断线重连后可继续附着）。 */
  close(): void {
    if (this.closed) return
    this.closed = true
    for (const sub of [...this.subscriptions.values()]) {
      sub.dispose()
    }
    this.subscriptions.clear()
    sessionRegistries.get(this.ctx)?.delete(this)
  }

  dispatch(request: RpcRequest, onReply: (callback: () => void) => void): unknown {
    if (this.closed) throw new MobileRequestError("DEVICE_REVOKED")
    switch (request.method) {
      case methods.list:
        return this.list(mobileParams(mobileTerminalListParams, request.params))
      case methods.open:
        return this.open(mobileParams(mobileTerminalOpenParams, request.params), onReply)
      case methods.attach:
        return this.attach(mobileParams(mobileTerminalAttachParams, request.params), onReply)
      case methods.detach:
        return this.detach(mobileParams(mobileTerminalDetachParams, request.params))
      case methods.write:
        return this.write(mobileParams(mobileTerminalWriteParams, request.params))
      case methods.resize:
        return this.resize(mobileParams(mobileTerminalResizeParams, request.params))
      case methods.close:
        return this.closeTerminal(mobileParams(mobileTerminalCloseParams, request.params))
      default:
        throw new MobileRequestError("METHOD_NOT_AVAILABLE")
    }
  }

  private requireService(): TerminalService {
    const terminal = this.ctx.get("terminal")
    if (!terminal) throw new MobileRequestError("METHOD_NOT_AVAILABLE")
    return terminal
  }

  private requireTerminal(terminalId: string, expectedThreadId?: string): TerminalSession {
    const terminal = this.requireService()
    const found = terminal.list().find((item) => item.id === terminalId)
    if (!found || found.threadId === null) {
      throw new MobileRequestError("TERMINAL_NOT_FOUND")
    }
    if (expectedThreadId !== undefined && found.threadId !== expectedThreadId) {
      throw new MobileRequestError("TERMINAL_NOT_FOUND")
    }
    requireMobileThread(this.ctx, found.threadId)
    return found
  }

  private assertWritable(session: TerminalSession): void {
    if (session.origin !== "mobile") {
      throw new MobileRequestError("TERMINAL_READ_ONLY")
    }
  }

  private list(params: MobileTerminalListParams): MobileTerminalListResult {
    requireMobileThread(this.ctx, params.threadId)
    const terminal = this.requireService()
    const terminals = terminal.list({ threadId: params.threadId }).map(toMobileSummary)
    return mobileTerminalListResult.parse({ terminals })
  }

  private async open(
    params: MobileTerminalOpenParams,
    onReply: (callback: () => void) => void,
  ): Promise<MobileTerminalOpenResult> {
    requireMobileThread(this.ctx, params.threadId)
    const terminal = this.requireService()
    const existingMobileCount = terminal
      .list({ threadId: params.threadId })
      .filter((item) => item.origin === "mobile").length
    if (existingMobileCount >= this.maxPerThread) {
      throw new MobileRequestError("TERMINAL_LIMIT_EXCEEDED")
    }

    const created = await terminal.open({ threadId: params.threadId }, params.cols, params.rows, {
      origin: "mobile",
    })

    // 异步 open 期间若连接已断开、设备被撤销或会话归档，立即关闭孤儿 PTY。
    try {
      if (this.closed) throw new MobileRequestError("DEVICE_REVOKED")
      this.requirePairedDevice()
      requireMobileThread(this.ctx, params.threadId)
    } catch (error) {
      try {
        terminal.close(created.id)
      } catch {
        // PTY 可能已自行退出。
      }
      throw error
    }

    const handle = this.installSubscription(created.id, 0, undefined)
    onReply(() => handle.start())
    return mobileTerminalOpenResult.parse({ terminal: toMobileSummary(handle.session) })
  }

  private attach(
    params: MobileTerminalAttachParams,
    onReply: (callback: () => void) => void,
  ): MobileTerminalAttachResult {
    const found = this.requireTerminal(params.terminalId, params.threadId)
    const resizeTarget =
      found.origin === "mobile" && params.cols !== undefined && params.rows !== undefined
        ? { cols: params.cols, rows: params.rows }
        : undefined
    const handle = this.installSubscription(found.id, params.afterCursor ?? 0, resizeTarget)
    onReply(() => handle.start())
    return mobileTerminalAttachResult.parse({
      terminal: toMobileSummary(handle.session),
      cursor: handle.cursor,
      replayChunks: handle.replayChunks,
      truncated: handle.truncated,
    })
  }

  private detach(params: MobileTerminalDetachParams): MobileTerminalDetachResult {
    const existing = this.subscriptions.get(params.terminalId)
    if (existing) {
      this.subscriptions.delete(params.terminalId)
      existing.dispose()
    }
    return mobileTerminalDetachResult.parse({ ok: true })
  }

  private write(params: MobileTerminalWriteParams): MobileTerminalWriteResult {
    const found = this.requireTerminal(params.terminalId)
    this.assertWritable(found)
    const terminal = this.requireService()
    const data = Buffer.from(params.dataBase64, "base64").toString("utf8")
    try {
      terminal.write(found.id, data)
    } catch {
      throw new MobileRequestError("TERMINAL_NOT_FOUND")
    }
    return mobileTerminalWriteResult.parse({ ok: true })
  }

  private resize(params: MobileTerminalResizeParams): MobileTerminalResizeResult {
    const found = this.requireTerminal(params.terminalId)
    this.assertWritable(found)
    const terminal = this.requireService()
    try {
      terminal.resize(found.id, params.cols, params.rows)
    } catch {
      throw new MobileRequestError("TERMINAL_NOT_FOUND")
    }
    return mobileTerminalResizeResult.parse({ cols: params.cols, rows: params.rows })
  }

  private closeTerminal(params: MobileTerminalCloseParams): MobileTerminalCloseResult {
    const found = this.requireTerminal(params.terminalId)
    this.assertWritable(found)
    const existing = this.subscriptions.get(found.id)
    if (existing) {
      this.subscriptions.delete(found.id)
      existing.dispose()
    }
    const terminal = this.requireService()
    try {
      terminal.close(found.id)
    } catch {
      throw new MobileRequestError("TERMINAL_NOT_FOUND")
    }
    return mobileTerminalCloseResult.parse({ closed: true })
  }

  private installSubscription(
    terminalId: string,
    afterCursor: number,
    resizeTarget: { cols: number; rows: number } | undefined,
  ): {
    session: TerminalSession
    cursor: number
    replayChunks: number
    truncated: boolean
    start(): void
  } {
    const previous = this.subscriptions.get(terminalId)
    if (previous) {
      this.subscriptions.delete(terminalId)
      previous.dispose()
    }

    const terminal = this.requireService()
    let buffering = true
    let disposed = false
    let overflowed = false
    let bufferedExit: number | undefined
    const preReplyChunks: Array<{ data: string; cursor: number }> = []
    let pendingChunks: Array<{ data: string; cursor: number; bytes: number }> = []
    let pendingBytes = 0
    let flushTimer: ReturnType<typeof setTimeout> | undefined

    const emitOutput = (
      data: string,
      cursor: number,
      flags?: { replay?: boolean; overflow?: boolean },
    ) => {
      if (disposed || this.closed) return
      const payload = mobileTerminalOutputNotification.parse({
        terminalId,
        dataBase64: data.length > 0 ? Buffer.from(data, "utf8").toString("base64") : "",
        cursor,
        ...(flags?.replay ? { replay: true } : {}),
        ...(flags?.overflow ? { overflow: true } : {}),
      })
      this.send({
        jsonrpc: "2.0",
        method: notifications.output,
        params: payload,
      })
    }

    const emitExit = (exitCode: number) => {
      if (disposed || this.closed) return
      const payload = mobileTerminalExitNotification.parse({ terminalId, exitCode })
      this.send({
        jsonrpc: "2.0",
        method: notifications.exit,
        params: payload,
      })
    }

    const clearTimer = () => {
      if (flushTimer !== undefined) {
        clearTimeout(flushTimer)
        flushTimer = undefined
      }
    }

    const flushPending = () => {
      clearTimer()
      if (disposed || this.closed || pendingChunks.length === 0) {
        pendingChunks = []
        pendingBytes = 0
        return
      }
      const lastCursor = pendingChunks[pendingChunks.length - 1]!.cursor
      const combined = pendingChunks.map((item) => item.data).join("")
      pendingChunks = []
      pendingBytes = 0
      for (const slice of sliceUtf8Chunks(combined, lastCursor, this.outputChunkBytes)) {
        emitOutput(slice.text, slice.cursor)
      }
    }

    const enqueueLive = (data: string, cursor: number) => {
      if (disposed || this.closed || overflowed || data.length === 0) return
      const bytes = Buffer.byteLength(data, "utf8")
      if (pendingBytes + bytes > this.maxPendingBytes) {
        clearTimer()
        pendingChunks = []
        pendingBytes = 0
        overflowed = true
        emitOutput("", cursor, { overflow: true })
        return
      }
      pendingChunks.push({ data, cursor, bytes })
      pendingBytes += bytes
      if (this.coalesceMs <= 0) {
        flushPending()
      } else if (flushTimer === undefined) {
        flushTimer = setTimeout(flushPending, this.coalesceMs)
        flushTimer.unref?.()
      }
    }

    let attached
    try {
      attached = terminal.attach(
        terminalId,
        (data, cursor) => {
          if (disposed || this.closed) return
          if (buffering) {
            preReplyChunks.push({ data, cursor })
          } else {
            enqueueLive(data, cursor)
          }
        },
        (exitCode) => {
          if (disposed || this.closed) return
          if (buffering) {
            bufferedExit = exitCode
            return
          }
          flushPending()
          if (this.subscriptions.get(terminalId) === handle) {
            this.subscriptions.delete(terminalId)
          }
          emitExit(exitCode)
          disposed = true
        },
        afterCursor,
      )
    } catch {
      throw new MobileRequestError("TERMINAL_NOT_FOUND")
    }

    const replaySlices = sliceUtf8Chunks(attached.replay, attached.cursor, this.outputChunkBytes)

    const handle: ActiveSubscription = {
      terminalId,
      start: () => {
        if (disposed || this.closed || !buffering) return
        // 1. 先按序发出回放分片（标记 replay: true）
        for (const slice of replaySlices) {
          emitOutput(slice.text, slice.cursor, { replay: true })
        }
        // 2. 再按序刷出 RPC 响应发出前暂存的实时输出
        if (preReplyChunks.length > 0) {
          const lastCursor = preReplyChunks[preReplyChunks.length - 1]!.cursor
          const combined = preReplyChunks.map((item) => item.data).join("")
          preReplyChunks.length = 0
          for (const slice of sliceUtf8Chunks(combined, lastCursor, this.outputChunkBytes)) {
            emitOutput(slice.text, slice.cursor)
          }
        }
        buffering = false
        // 3. 若期间终端已退出，立即补发退出通知并清理
        if (bufferedExit !== undefined) {
          const code = bufferedExit
          bufferedExit = undefined
          if (this.subscriptions.get(terminalId) === handle) {
            this.subscriptions.delete(terminalId)
          }
          emitExit(code)
          handle.dispose()
          return
        }
        // 4. 仅手机自建终端允许在重放之后调整尺寸
        if (
          resizeTarget &&
          (resizeTarget.cols !== attached.session.cols ||
            resizeTarget.rows !== attached.session.rows)
        ) {
          try {
            terminal.resize(terminalId, resizeTarget.cols, resizeTarget.rows)
          } catch {
            // 响应发出与回调之间终端可能刚退出。
          }
        }
      },
      dispose: () => {
        if (disposed) return
        disposed = true
        clearTimer()
        preReplyChunks.length = 0
        pendingChunks = []
        pendingBytes = 0
        attached.unsubscribe()
      },
    }

    this.subscriptions.set(terminalId, handle)
    return {
      session: attached.session,
      cursor: attached.cursor,
      replayChunks: replaySlices.length,
      truncated: attached.truncated,
      start: handle.start,
    }
  }
}
