/** 把一个终端的输出与退出转成发给页面的通知：terminal.output 与 terminal.exit。 */
import type { TerminalService } from "../services/terminal"

/** 页面通知的形状。 */
interface Notification {
  jsonrpc: "2.0"
  method: string
  params: unknown
}

/** 订阅终端并转发给页面；返回的函数取消订阅（换页面时调用）。 */
export function forwardTerminal(
  terminal: TerminalService,
  terminalId: string,
  send: (message: Notification) => void,
): () => void {
  return terminal.subscribe(
    terminalId,
    (data) => send({ jsonrpc: "2.0", method: "terminal.output", params: { terminalId, data } }),
    (exitCode) =>
      send({ jsonrpc: "2.0", method: "terminal.exit", params: { terminalId, exitCode } }),
  )
}
