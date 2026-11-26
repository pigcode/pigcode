/** 手机端远程终端 RPC 与流式推送控制器：归属隔离（电脑只读/手机可写）、有序分片回放、16ms 合并与背压保护。 */
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
  mobileTerminalListParams,
  mobileTerminalListResult,
  mobileTerminalMethods as methods,
  mobileTerminalOpenParams,
  mobileTerminalOpenResult,
  mobileTerminalResizeParams,
  mobileTerminalResizeResult,
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
  type MobileTerminalWriteParams,
  type MobileTerminalWriteResult,
  type RpcRequest,
} from "@pigcode/contracts"
import type { Context } from "cordis"
import type { TerminalService, TerminalSession } from "../services/terminal"
import { requireMobileThread } from "./command-receipts"
import { mobileParams, MobileRequestError } from "./request-error"
import {
  createTerminalSubscription,
  sliceUtf8Chunks,
  toMobileTerminalSummary,
  type ActiveTerminalSubscription,
} from "./terminal-stream"

export { sliceUtf8Chunks }

export const mobileTerminalRequests: ReadonlySet<string> = new Set(Object.values(methods))

export interface MobileTerminalOptions {
  outputChunkBytes?: number
  coalesceMs?: number
  maxPendingBytes?: number
  maxPerThread?: number
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

export class MobileTerminalSession {
  private readonly subscriptions = new Map<string, ActiveTerminalSubscription>()
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
    const terminals = terminal.list({ threadId: params.threadId }).map(toMobileTerminalSummary)
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
    return mobileTerminalOpenResult.parse({ terminal: toMobileTerminalSummary(handle.session) })
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
      terminal: toMobileTerminalSummary(handle.session),
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
  ) {
    const previous = this.subscriptions.get(terminalId)
    if (previous) {
      this.subscriptions.delete(terminalId)
      previous.dispose()
    }

    const installed = createTerminalSubscription({
      terminal: this.requireService(),
      terminalId,
      afterCursor,
      resizeTarget,
      settings: {
        outputChunkBytes: this.outputChunkBytes,
        coalesceMs: this.coalesceMs,
        maxPendingBytes: this.maxPendingBytes,
      },
      isClosed: () => this.closed,
      send: this.send,
      removeIfCurrent: (handle) => {
        if (this.subscriptions.get(terminalId) === handle) {
          this.subscriptions.delete(terminalId)
        }
      },
    })

    this.subscriptions.set(terminalId, installed.handle)
    return {
      session: installed.session,
      cursor: installed.cursor,
      replayChunks: installed.replayChunks,
      truncated: installed.truncated,
      start: installed.handle.start,
    }
  }
}
