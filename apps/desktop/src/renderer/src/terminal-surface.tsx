/** 终端 surface：挂载时打开一个 PTY，卸载时关闭；右侧面板的终端标签与底部终端共用。 */
import { useEffect, useRef, useState, type ReactNode } from "react"
import type { Connection } from "@pigcode/client-runtime"
import { useLocale } from "@pigcode/ui-primitives"
import { TerminalView, type TerminalHandle } from "@pigcode/ui-workbench"

/** terminal.open 返回的会话。 */
interface TerminalSession {
  id: string
  cols: number
  rows: number
}

/** 终端初始尺寸；xterm 挂载后会通过 fit 与 resize 修正。 */
const TERMINAL_COLS = 80
const TERMINAL_ROWS = 24

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** 终端 surface 属性。 */
export interface TerminalSurfaceProps {
  connection: Connection
  threadId: string
  /** 当前是否可见；变为可见时聚焦。 */
  active: boolean
  /** 浮在终端右上角的操作按钮。 */
  tools?: ReactNode
}

/** 一个独立的 shell 会话。 */
export function TerminalSurface({ connection, threadId, active, tools }: TerminalSurfaceProps) {
  const { t } = useLocale()
  const [terminalId, setTerminalId] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const handle = useRef<TerminalHandle | null>(null)
  const activeRef = useRef(active)
  activeRef.current = active

  useEffect(() => {
    let cancelled = false
    let openedId: string | null = null
    void connection
      .call("terminal.open", { threadId, cols: TERMINAL_COLS, rows: TERMINAL_ROWS })
      .then((result) => {
        const session = result as TerminalSession
        openedId = session.id
        if (cancelled) {
          void connection.call("terminal.close", { terminalId: session.id }).catch(() => undefined)
          return
        }
        setTerminalId(session.id)
      })
      .catch((cause: unknown) => {
        if (!cancelled) setError(messageOf(cause))
      })
    return () => {
      cancelled = true
      if (openedId) {
        void connection.call("terminal.close", { terminalId: openedId }).catch(() => undefined)
      }
    }
  }, [connection, threadId])

  useEffect(() => {
    if (!terminalId) return undefined
    return connection.onTerminalOutput((output) => {
      if (output.terminalId === terminalId) handle.current?.write(output.data)
    })
  }, [connection, terminalId])

  useEffect(() => {
    if (!active) return
    handle.current?.fit()
    handle.current?.focus()
  }, [active])

  function send(data: string): void {
    if (!terminalId) return
    void connection
      .call("terminal.write", { terminalId, data })
      .catch((cause: unknown) => setError(messageOf(cause)))
  }

  function resize(cols: number, rows: number): void {
    if (!terminalId) return
    void connection
      .call("terminal.resize", { terminalId, cols, rows })
      .catch((cause: unknown) => setError(messageOf(cause)))
  }

  function ready(next: TerminalHandle | null): void {
    handle.current = next
    if (activeRef.current) next?.focus()
  }

  return (
    <div className="terminal-surface">
      {error ? (
        <p className="workbench-error">{error}</p>
      ) : terminalId ? (
        <TerminalView onData={send} onResize={resize} onReady={ready} />
      ) : (
        // terminal.open 是异步 RPC；会话就绪前不挂载 xterm，避免输入被静默丢弃。
        <p className="workbench-empty">{t("workbench.terminalOpening")}</p>
      )}
      {tools ? <div className="terminal-surface-tools">{tools}</div> : null}
    </div>
  )
}
