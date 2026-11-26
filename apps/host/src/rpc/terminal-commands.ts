/** 终端相关的 RPC 命令分发及页面订阅管理。 */
import type { Context } from "cordis"
import type { CommandMethod, CommandParams } from "@pigcode/contracts"
import {
  attachDesktopTerminal,
  forwardTerminal,
  type TerminalNotification,
} from "./terminal-notify"
import { scopeOf } from "./workbench-commands"

export const TERMINAL_COMMANDS = new Set<CommandMethod>([
  "terminal.open",
  "terminal.list",
  "terminal.attach",
  "terminal.rebind",
  "terminal.write",
  "terminal.resize",
  "terminal.close",
])

export interface TerminalCommandState {
  subscriptions: Map<string, () => void>
  getPage: () => number
  send: (message: TerminalNotification) => void
  onReply: (callback: () => void) => void
}

export async function dispatchTerminalCommand(
  ctx: Context,
  command: CommandMethod,
  parsed: unknown,
  state: TerminalCommandState,
): Promise<unknown> {
  switch (command) {
    case "terminal.open": {
      const value = parsed as CommandParams<"terminal.open">
      const page = state.getPage()
      const scope = scopeOf(value)
      const owner = typeof scope === "string" ? { threadId: scope } : scope
      const terminal = await ctx.terminal.open(
        owner,
        value.cols,
        value.rows,
        value.placement ? { placement: value.placement } : undefined,
      )
      if (page !== state.getPage()) {
        try {
          ctx.terminal.close(terminal.id)
        } catch {
          // 终端可能已自行退出。
        }
        return terminal
      }
      state.subscriptions.get(terminal.id)?.()
      const handle: { dispose?: () => void } = {}
      handle.dispose = forwardTerminal(ctx.terminal, terminal.id, state.send, () => {
        if (state.subscriptions.get(terminal.id) === handle.dispose) {
          state.subscriptions.delete(terminal.id)
        }
      })
      state.subscriptions.set(terminal.id, handle.dispose)
      return terminal
    }
    case "terminal.list": {
      const value = parsed as CommandParams<"terminal.list">
      const scope = scopeOf(value)
      const owner = typeof scope === "string" ? { threadId: scope } : scope
      return ctx.terminal.list(owner)
    }
    case "terminal.attach": {
      const value = parsed as CommandParams<"terminal.attach">
      state.subscriptions.get(value.terminalId)?.()
      state.subscriptions.delete(value.terminalId)
      const handle: { release?: () => void } = {}
      const attached = attachDesktopTerminal(
        ctx.terminal,
        value.terminalId,
        {
          afterCursor: value.afterCursor,
          cols: value.cols,
          rows: value.rows,
        },
        state.send,
        () => {
          if (state.subscriptions.get(value.terminalId) === handle.release) {
            state.subscriptions.delete(value.terminalId)
          }
        },
      )
      handle.release = attached.release
      state.subscriptions.set(value.terminalId, handle.release)
      state.onReply(attached.afterReply)
      return attached.result
    }
    case "terminal.rebind": {
      const value = parsed as CommandParams<"terminal.rebind">
      return ctx.terminal.rebind(value.terminalId, value.threadId)
    }
    case "terminal.write": {
      const value = parsed as { terminalId: string; data: string }
      return ctx.terminal.write(value.terminalId, value.data)
    }
    case "terminal.resize": {
      const value = parsed as { terminalId: string; cols: number; rows: number }
      return ctx.terminal.resize(value.terminalId, value.cols, value.rows)
    }
    case "terminal.close": {
      const { terminalId } = parsed as { terminalId: string }
      state.subscriptions.get(terminalId)?.()
      state.subscriptions.delete(terminalId)
      return ctx.terminal.close(terminalId)
    }
    default:
      throw new Error(`unsupported method: ${command}`)
  }
}
