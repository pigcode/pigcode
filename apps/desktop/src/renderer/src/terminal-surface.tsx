/**
 * 终端 surface：先挂上 xterm 量出尺寸，再按这个尺寸打开一个 PTY，卸载时关闭；
 * 右侧面板的终端标签与底部终端共用。
 */
import { useEffect, useRef, useState, type ReactNode } from "react"
import { Loader2 } from "lucide-react"
import type { Connection } from "@pigcode/client-runtime"
import { EmptyState, useLocale } from "@pigcode/ui-primitives"
import { TerminalView, type TerminalHandle } from "@pigcode/ui-workbench"
import type { WorkspaceScope } from "./workspace-scope"

/** terminal.open 返回的会话。 */
export interface TerminalSession {
  id: string
  cols: number
  rows: number
  /** shell 的名字，例如 zsh；旧版 Host 不给。 */
  shell?: string | undefined
  /** shell 的工作目录；旧版 Host 不给。 */
  cwd?: string | undefined
}

/** xterm 还没量出尺寸时的行列数；shell 按量出来的尺寸启动。 */
const TERMINAL_COLS = 80
const TERMINAL_ROWS = 24

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** 终端挂在谁身上：会话里挂在会话上；新会话草稿里还没有会话，挂在草稿的项目上（开在项目根目录）。 */
export type TerminalOwner = WorkspaceScope

/** 终端 surface 属性。 */
export interface TerminalSurfaceProps {
  connection: Connection
  /**
   * 只在启动 shell 时读一次：草稿变成会话后 owner 换成会话，已经开着的 shell 不重开，
   * 里面跑着的命令也不会断。
   */
  owner: TerminalOwner
  /** 当前是否可见；变为可见时聚焦。 */
  active: boolean
  /** 浮在终端右上角的操作按钮。 */
  tools?: ReactNode
  /** shell 已经起来：底部终端用它的名字与目录给标签起名。 */
  onOpened?: ((session: TerminalSession) => void) | undefined
  /** shell 自己退出了（例如输入 exit）。 */
  onExit?: (() => void) | undefined
}

/** 一个独立的 shell 会话。 */
export function TerminalSurface({
  connection,
  owner,
  active,
  tools,
  onOpened,
  onExit,
}: TerminalSurfaceProps) {
  const { t } = useLocale()
  const [terminalId, setTerminalId] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  // 先挂上 xterm 量出面板能放下的行列数，再按这个尺寸启动 shell。
  // 不能先按 80×24 启动再改：shell 可能在改尺寸之前就画好了第一个提示符（fish 两行提示符的第一行、
  // 右侧的时间），按 80 列画的那一行之后不会重画。
  const [measured, setMeasured] = useState(false)
  const size = useRef({ cols: TERMINAL_COLS, rows: TERMINAL_ROWS })
  const idRef = useRef<string | null>(null)
  /** shell 起来之前敲的字，起来后按顺序补发。 */
  const pending = useRef<string[]>([])
  const handle = useRef<TerminalHandle | null>(null)
  const activeRef = useRef(active)
  activeRef.current = active
  // 回调可能每次渲染都换；放进 ref，打开终端的 effect 不因此重跑。
  const callbacks = useRef({ onOpened, onExit })
  callbacks.current = { onOpened, onExit }
  const ownerRef = useRef(owner)
  ownerRef.current = owner

  useEffect(() => {
    if (!measured) return undefined
    let cancelled = false
    let openedId: string | null = null
    const opening = { ...size.current }
    void connection
      .call("terminal.open", { ...ownerRef.current, ...opening })
      .then((result) => {
        const session = result as TerminalSession
        openedId = session.id
        if (cancelled) {
          void connection.call("terminal.close", { terminalId: session.id }).catch(() => undefined)
          return
        }
        idRef.current = session.id
        setTerminalId(session.id)
        callbacks.current.onOpened?.(session)
        // 等 open 返回的这段时间面板尺寸又变了：补一次 resize。
        const now = size.current
        if (now.cols !== opening.cols || now.rows !== opening.rows) {
          void connection
            .call("terminal.resize", { terminalId: session.id, ...now })
            .catch(() => undefined)
        }
        for (const data of pending.current.splice(0)) {
          void connection
            .call("terminal.write", { terminalId: session.id, data })
            .catch(() => undefined)
        }
      })
      .catch((cause: unknown) => {
        if (!cancelled) setError(messageOf(cause))
      })
    return () => {
      cancelled = true
      idRef.current = null
      if (openedId) {
        void connection.call("terminal.close", { terminalId: openedId }).catch(() => undefined)
      }
    }
  }, [connection, measured])

  useEffect(() => {
    if (!terminalId) return undefined
    const offOutput = connection.onTerminalOutput((output) => {
      if (output.terminalId === terminalId) handle.current?.write(output.data)
    })
    const offExit = connection.onTerminalExit((exit) => {
      if (exit.terminalId === terminalId) callbacks.current.onExit?.()
    })
    return () => {
      offOutput()
      offExit()
    }
  }, [connection, terminalId])

  useEffect(() => {
    if (!active) return
    handle.current?.fit()
    handle.current?.focus()
  }, [active])

  function send(data: string): void {
    const id = idRef.current
    if (!id) {
      pending.current.push(data)
      return
    }
    void connection
      .call("terminal.write", { terminalId: id, data })
      .catch((cause: unknown) => setError(messageOf(cause)))
  }

  function resize(cols: number, rows: number): void {
    size.current = { cols, rows }
    const id = idRef.current
    if (!id) {
      setMeasured(true)
      return
    }
    void connection
      .call("terminal.resize", { terminalId: id, cols, rows })
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
      ) : (
        <>
          <TerminalView onData={send} onResize={resize} onReady={ready} />
          {terminalId ? null : (
            <div className="terminal-surface-loading">
              <EmptyState
                icon={<Loader2 className="ic spin" />}
                title={t("workbench.terminalOpening")}
              />
            </div>
          )}
        </>
      )}
      {tools ? <div className="terminal-surface-tools">{tools}</div> : null}
    </div>
  )
}
