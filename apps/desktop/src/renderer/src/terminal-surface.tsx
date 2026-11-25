/**
 * 终端 surface：先挂上 xterm 量出尺寸，再按这个尺寸打开新 PTY 或重新附着到已有 PTY，卸载时关闭；
 * 右侧面板的终端标签与底部终端共用。
 */
import { useEffect, useRef, useState, type ReactNode } from "react"
import { Loader2 } from "lucide-react"
import type { Connection } from "@pigcode/client-runtime"
import type { TerminalPlacement } from "@pigcode/contracts"
import { EmptyState, useLocale } from "@pigcode/ui-primitives"
import { TerminalView, type TerminalHandle } from "@pigcode/ui-workbench"
import type { WorkspaceScope } from "./workspace-scope"

/** terminal.open / terminal.list 返回的终端会话。 */
export interface TerminalSession {
  id: string
  /** 在新会话草稿里打开的终端没有会话；旧版 Host 不给。 */
  threadId?: string | null | undefined
  /** 终端所在的项目；旧版 Host 不给。 */
  projectId?: string | undefined
  cols: number
  rows: number
  /** shell 的名字，例如 zsh；旧版 Host 不给。 */
  shell?: string | undefined
  /** shell 的工作目录；旧版 Host 不给。 */
  cwd?: string | undefined
  /** 累计输出单调游标（UTF-16 字符偏移）；旧版 Host 不给。 */
  cursor?: number | undefined
  /** 打开位置（抽屉或右侧 Workbench）；旧版 Host 不给。 */
  placement?: TerminalPlacement | undefined
  /** ISO 创建时间；旧版 Host 不给。 */
  createdAt?: string | undefined
}

/** terminal.attach 的响应载荷。 */
interface TerminalAttachResponse {
  session: TerminalSession
  replay: string
  cursor: number
  truncated: boolean
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
   * 初始启动 shell 时按此归属；草稿变成会话后 owner 换成会话，已经开着的 shell 不重开，
   * 而是平滑调用 terminal.rebind 改绑到新会话，确保刷新后仍能找回。
   */
  owner: TerminalOwner
  /** 当前是否可见；变为可见时聚焦。 */
  active: boolean
  /** 终端在窗口里打开的位置；供页面刷新后放回原位置。 */
  placement?: TerminalPlacement | undefined
  /** 重新附着到 Host 上已有的活跃终端；提供时走 terminal.attach 而不新开。 */
  attachTerminalId?: string | undefined
  /** 浮在终端右上角的操作按钮。 */
  tools?: ReactNode
  /** shell 已经起来或附着完成：底部终端用它的名字与目录给标签起名。 */
  onOpened?: ((session: TerminalSession) => void) | undefined
  /** shell 自己退出了（例如输入 exit），或要附着的终端已提前退出。 */
  onExit?: (() => void) | undefined
}

/** 一个独立的 shell 会话。 */
export function TerminalSurface({
  connection,
  owner,
  active,
  placement,
  attachTerminalId,
  tools,
  onOpened,
  onExit,
}: TerminalSurfaceProps) {
  const { t } = useLocale()
  const [terminalId, setTerminalId] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  // 先挂上 xterm 量出面板能放下的行列数，再按这个尺寸启动或附着 shell。
  const [measured, setMeasured] = useState(false)
  const size = useRef({ cols: TERMINAL_COLS, rows: TERMINAL_ROWS })
  const idRef = useRef<string | null>(null)
  const cursorRef = useRef(0)
  const exitedRef = useRef(false)
  // 锁定初次挂载时的 attach 目标：新开终端在 onOpened 回填 tab.terminalId 时不能触发重跑。
  const initialAttachIdRef = useRef(attachTerminalId)
  const placementRef = useRef(placement)
  placementRef.current = placement
  /** 记录终端在 Host 上已绑定的会话 id；从草稿（null）变为正式会话时自动触发 terminal.rebind。 */
  const boundThreadIdRef = useRef<string | null>("threadId" in owner ? owner.threadId : null)
  /** shell 起来之前敲的字，起来后按顺序补发。 */
  const pending = useRef<string[]>([])
  const handle = useRef<TerminalHandle | null>(null)
  const activeRef = useRef(active)
  activeRef.current = active
  // 回调可能每次渲染都换；放进 ref，打开/附着终端的 effect 不因此重跑。
  const callbacks = useRef({ onOpened, onExit })
  callbacks.current = { onOpened, onExit }
  const ownerRef = useRef(owner)
  ownerRef.current = owner

  useEffect(() => {
    if (!measured) return undefined
    let cancelled = false
    let activeId: string | null = null
    let liveReady = false
    let bufferedExit = false
    const bufferedLive: Array<{ data: string; cursor?: number | undefined }> = []
    exitedRef.current = false
    cursorRef.current = 0

    const targetAttachId = initialAttachIdRef.current
    const opening = { ...size.current }

    function writeLive(data: string, cursor?: number): void {
      if (cursor !== undefined && cursor <= cursorRef.current) return
      if (cursor !== undefined) cursorRef.current = cursor
      handle.current?.write(data)
    }

    function rebindIfNeeded(sessionId: string, sessionThreadId: string | null | undefined): void {
      const currentOwner = ownerRef.current
      if (
        "threadId" in currentOwner &&
        boundThreadIdRef.current === null &&
        sessionThreadId !== currentOwner.threadId
      ) {
        boundThreadIdRef.current = currentOwner.threadId
        void connection
          .call("terminal.rebind", { terminalId: sessionId, threadId: currentOwner.threadId })
          .catch(() => undefined)
      } else if (sessionThreadId) {
        boundThreadIdRef.current = sessionThreadId
      }
    }

    function flushResizeAndPending(sessionId: string): void {
      const now = size.current
      if (now.cols !== opening.cols || now.rows !== opening.rows) {
        void connection
          .call("terminal.resize", { terminalId: sessionId, ...now })
          .catch(() => undefined)
      }
      for (const data of pending.current.splice(0)) {
        void connection
          .call("terminal.write", { terminalId: sessionId, data })
          .catch(() => undefined)
      }
    }

    // 在发出 open/attach 请求前先同步订阅实时通知，避免 afterReply 早于 React 重渲染导致丢帧。
    const offOutput = connection.onTerminalOutput((output) => {
      const expected = activeId ?? targetAttachId
      if (!expected || output.terminalId !== expected) return
      if (!liveReady) {
        bufferedLive.push({ data: output.data, cursor: output.cursor })
        return
      }
      writeLive(output.data, output.cursor)
    })
    const offExit = connection.onTerminalExit((exit) => {
      const expected = activeId ?? targetAttachId
      if (!expected || exit.terminalId !== expected) return
      if (!liveReady) {
        bufferedExit = true
        return
      }
      exitedRef.current = true
      callbacks.current.onExit?.()
    })
    // 页面未刷新但发生传输层重连（例如重新接通 Host 或 Host 重启）时，从当前游标自动续接订阅。
    const offReconnect = connection.onReconnect?.(() => {
      if (cancelled || exitedRef.current) return
      const id = activeId ?? idRef.current
      if (!id) return
      liveReady = false
      const reattachSize = { ...size.current }
      void connection
        .call("terminal.attach", {
          terminalId: id,
          afterCursor: cursorRef.current,
          ...reattachSize,
        })
        .then((raw) => {
          if (cancelled || activeId !== id) return
          const result = raw as TerminalAttachResponse
          if (result.replay.length > 0 && result.cursor > cursorRef.current) {
            handle.current?.write(result.replay)
          }
          cursorRef.current = Math.max(cursorRef.current, result.cursor)
          for (const item of bufferedLive.splice(0)) writeLive(item.data, item.cursor)
          liveReady = true
          if (bufferedExit) {
            exitedRef.current = true
            callbacks.current.onExit?.()
          }
        })
        .catch((cause: unknown) => {
          if (cancelled || activeId !== id) return
          if (/terminal not found/i.test(messageOf(cause))) {
            exitedRef.current = true
            callbacks.current.onExit?.()
            return
          }
          for (const item of bufferedLive.splice(0)) writeLive(item.data, item.cursor)
          liveReady = true
        })
    })

    if (targetAttachId) {
      void connection
        .call("terminal.attach", { terminalId: targetAttachId, ...opening })
        .then((raw) => {
          // 附着途中被取消（例如 StrictMode 双重挂载第一次清理）绝不关闭已有终端。
          if (cancelled) return
          const result = raw as TerminalAttachResponse
          activeId = result.session.id
          idRef.current = result.session.id
          cursorRef.current = result.cursor
          if (result.replay.length > 0) handle.current?.write(result.replay)
          for (const item of bufferedLive.splice(0)) writeLive(item.data, item.cursor)
          liveReady = true
          setTerminalId(result.session.id)
          callbacks.current.onOpened?.(result.session)
          rebindIfNeeded(result.session.id, result.session.threadId)
          if (bufferedExit) {
            exitedRef.current = true
            callbacks.current.onExit?.()
            return
          }
          flushResizeAndPending(result.session.id)
        })
        .catch((cause: unknown) => {
          if (cancelled) return
          if (/terminal not found/i.test(messageOf(cause))) {
            exitedRef.current = true
            callbacks.current.onExit?.()
            return
          }
          setError(messageOf(cause))
        })
    } else {
      void connection
        .call("terminal.open", {
          ...ownerRef.current,
          ...opening,
          ...(placementRef.current ? { placement: placementRef.current } : {}),
        })
        .then((raw) => {
          const session = raw as TerminalSession
          if (cancelled) {
            void connection.call("terminal.close", { terminalId: session.id }).catch(() => undefined)
            return
          }
          activeId = session.id
          idRef.current = session.id
          cursorRef.current = session.cursor ?? 0
          liveReady = true
          setTerminalId(session.id)
          callbacks.current.onOpened?.(session)
          rebindIfNeeded(session.id, session.threadId)
          flushResizeAndPending(session.id)
        })
        .catch((cause: unknown) => {
          if (!cancelled) setError(messageOf(cause))
        })
    }

    return () => {
      cancelled = true
      offOutput()
      offExit()
      offReconnect?.()
      idRef.current = null
      if (activeId && !exitedRef.current) {
        void connection.call("terminal.close", { terminalId: activeId }).catch(() => undefined)
      }
    }
  }, [connection, measured])

  const ownerThreadId = "threadId" in owner ? owner.threadId : null
  useEffect(() => {
    if (!ownerThreadId || boundThreadIdRef.current !== null) return
    const id = idRef.current
    if (!id) return
    boundThreadIdRef.current = ownerThreadId
    void connection
      .call("terminal.rebind", { terminalId: id, threadId: ownerThreadId })
      .catch(() => undefined)
  }, [connection, ownerThreadId])

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
