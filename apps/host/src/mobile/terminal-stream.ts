/** 手机端远程终端的 UTF-8 分片、摘要投影及流式订阅（回放、16ms 合并、背压溢出与退出转发）。 */
import { basename } from "node:path"
import {
  mobileTerminalExitNotification,
  mobileTerminalNotifications as notifications,
  mobileTerminalOutputNotification,
  mobileTerminalSummarySchema,
  type MobileTerminalSummary,
} from "@pigcode/contracts"
import type { TerminalService, TerminalSession } from "../services/terminal"
import { MobileRequestError } from "./request-error"

export interface ActiveTerminalSubscription {
  terminalId: string
  start(): void
  dispose(): void
}

export interface TerminalStreamSettings {
  outputChunkBytes: number
  coalesceMs: number
  maxPendingBytes: number
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

export function toMobileTerminalSummary(session: TerminalSession): MobileTerminalSummary {
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

export function createTerminalSubscription(options: {
  terminal: TerminalService
  terminalId: string
  afterCursor: number
  resizeTarget: { cols: number; rows: number } | undefined
  settings: TerminalStreamSettings
  isClosed: () => boolean
  send: (message: unknown) => void
  removeIfCurrent: (handle: ActiveTerminalSubscription) => void
}): {
  session: TerminalSession
  cursor: number
  replayChunks: number
  truncated: boolean
  handle: ActiveTerminalSubscription
} {
  const {
    terminal,
    terminalId,
    afterCursor,
    resizeTarget,
    settings,
    isClosed,
    send,
    removeIfCurrent,
  } = options

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
    if (disposed || isClosed()) return
    const payload = mobileTerminalOutputNotification.parse({
      terminalId,
      dataBase64: data.length > 0 ? Buffer.from(data, "utf8").toString("base64") : "",
      cursor,
      ...(flags?.replay ? { replay: true } : {}),
      ...(flags?.overflow ? { overflow: true } : {}),
    })
    send({
      jsonrpc: "2.0",
      method: notifications.output,
      params: payload,
    })
  }

  const emitExit = (exitCode: number) => {
    if (disposed || isClosed()) return
    const payload = mobileTerminalExitNotification.parse({ terminalId, exitCode })
    send({
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
    if (disposed || isClosed() || pendingChunks.length === 0) {
      pendingChunks = []
      pendingBytes = 0
      return
    }
    const lastCursor = pendingChunks[pendingChunks.length - 1]!.cursor
    const combined = pendingChunks.map((item) => item.data).join("")
    pendingChunks = []
    pendingBytes = 0
    for (const slice of sliceUtf8Chunks(combined, lastCursor, settings.outputChunkBytes)) {
      emitOutput(slice.text, slice.cursor)
    }
  }

  const enqueueLive = (data: string, cursor: number) => {
    if (disposed || isClosed() || overflowed || data.length === 0) return
    const bytes = Buffer.byteLength(data, "utf8")
    if (pendingBytes + bytes > settings.maxPendingBytes) {
      clearTimer()
      pendingChunks = []
      pendingBytes = 0
      overflowed = true
      emitOutput("", cursor, { overflow: true })
      return
    }
    pendingChunks.push({ data, cursor, bytes })
    pendingBytes += bytes
    if (settings.coalesceMs <= 0) {
      flushPending()
    } else if (flushTimer === undefined) {
      flushTimer = setTimeout(flushPending, settings.coalesceMs)
      flushTimer.unref?.()
    }
  }

  let attached
  try {
    attached = terminal.attach(
      terminalId,
      (data, cursor) => {
        if (disposed || isClosed()) return
        if (buffering) {
          preReplyChunks.push({ data, cursor })
        } else {
          enqueueLive(data, cursor)
        }
      },
      (exitCode) => {
        if (disposed || isClosed()) return
        if (buffering) {
          bufferedExit = exitCode
          return
        }
        flushPending()
        removeIfCurrent(handle)
        emitExit(exitCode)
        disposed = true
      },
      afterCursor,
    )
  } catch {
    throw new MobileRequestError("TERMINAL_NOT_FOUND")
  }

  const replaySlices = sliceUtf8Chunks(attached.replay, attached.cursor, settings.outputChunkBytes)

  const handle: ActiveTerminalSubscription = {
    terminalId,
    start: () => {
      if (disposed || isClosed() || !buffering) return
      // 1. 先按序发出回放分片（标记 replay: true）
      for (const slice of replaySlices) {
        emitOutput(slice.text, slice.cursor, { replay: true })
      }
      // 2. 再按序刷出 RPC 响应发出前暂存的实时输出
      if (preReplyChunks.length > 0) {
        const lastCursor = preReplyChunks[preReplyChunks.length - 1]!.cursor
        const combined = preReplyChunks.map((item) => item.data).join("")
        preReplyChunks.length = 0
        for (const slice of sliceUtf8Chunks(combined, lastCursor, settings.outputChunkBytes)) {
          emitOutput(slice.text, slice.cursor)
        }
      }
      buffering = false
      // 3. 若期间终端已退出，立即补发退出通知并清理
      if (bufferedExit !== undefined) {
        const code = bufferedExit
        bufferedExit = undefined
        removeIfCurrent(handle)
        emitExit(code)
        handle.dispose()
        return
      }
      // 4. 仅手机自建终端允许在重放之后调整尺寸
      if (
        resizeTarget &&
        (resizeTarget.cols !== attached.session.cols || resizeTarget.rows !== attached.session.rows)
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

  return {
    session: attached.session,
    cursor: attached.cursor,
    replayChunks: replaySlices.length,
    truncated: attached.truncated,
    handle,
  }
}
