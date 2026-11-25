/** 把一个终端的输出与退出转成发给页面的通知：terminal.output 与 terminal.exit。 */
import type { TerminalAttachResult, TerminalService } from "../services/terminal"

/** 页面通知的形状。 */
export interface TerminalNotification {
  jsonrpc: "2.0"
  method: string
  params: unknown
}

/** 订阅终端并转发给页面（携带单调游标）；返回的函数取消订阅（换页面或关闭时调用）。 */
export function forwardTerminal(
  terminal: TerminalService,
  terminalId: string,
  send: (message: TerminalNotification) => void,
  onExited?: () => void,
): () => void {
  const { unsubscribe } = terminal.attach(
    terminalId,
    (data, cursor) =>
      send({
        jsonrpc: "2.0",
        method: "terminal.output",
        params: { terminalId, data, cursor },
      }),
    (exitCode) => {
      onExited?.()
      send({
        jsonrpc: "2.0",
        method: "terminal.exit",
        params: { terminalId, exitCode },
      })
    },
  )
  return unsubscribe
}

/**
 * 重新附着终端并转发后续实时输出：
 * 在 `terminal.attach` RPC 响应发完前到达的输出/退出先暂存，在 `afterReply` 中按序刷出；
 * 若客户端传了新的 cols/rows，也在 `afterReply` 之后执行 resize，避免重放与实时推送乱序。
 */
export function attachDesktopTerminal(
  terminal: TerminalService,
  terminalId: string,
  options: {
    afterCursor?: number | undefined
    cols?: number | undefined
    rows?: number | undefined
  },
  send: (message: TerminalNotification) => void,
  onExited?: () => void,
): {
  result: Omit<TerminalAttachResult, "unsubscribe">
  afterReply: () => void
  release: () => void
} {
  const queued: TerminalNotification[] = []
  let ready = false
  let released = false
  let exited = false
  const forward = (message: TerminalNotification) => {
    if (released) return
    if (ready) send(message)
    else queued.push(message)
  }
  const attached = terminal.attach(
    terminalId,
    (data, cursor) => {
      forward({
        jsonrpc: "2.0",
        method: "terminal.output",
        params: { terminalId, data, cursor },
      })
    },
    (exitCode) => {
      exited = true
      onExited?.()
      forward({
        jsonrpc: "2.0",
        method: "terminal.exit",
        params: { terminalId, exitCode },
      })
    },
    options.afterCursor,
  )
  return {
    result: {
      session: attached.session,
      replay: attached.replay,
      cursor: attached.cursor,
      truncated: attached.truncated,
    },
    afterReply() {
      if (released) return
      ready = true
      for (const message of queued) send(message)
      queued.length = 0
      if (exited) return
      const nextCols = options.cols ?? attached.session.cols
      const nextRows = options.rows ?? attached.session.rows
      if (nextCols !== attached.session.cols || nextRows !== attached.session.rows) {
        try {
          terminal.resize(terminalId, nextCols, nextRows)
        } catch {
          // 响应发出与微任务之间终端可能刚好已退出。
        }
      }
    },
    release() {
      if (released) return
      released = true
      queued.length = 0
      attached.unsubscribe()
    },
  }
}
