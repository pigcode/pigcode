/** 终端视图：封装 xterm 实例、fit addon 与 resize observer。 */
import { useEffect, useRef } from "react"
import { FitAddon } from "@xterm/addon-fit"
import { Terminal, type ITheme } from "@xterm/xterm"

/** 父组件持有的终端句柄；用于写入 PTY 输出和主动聚焦。 */
export interface TerminalHandle {
  write(data: string): void
  fit(): void
  focus(): void
}

/** 终端视图属性；所有 PTY 生命周期由父组件管理。 */
export interface TerminalViewProps {
  onData?: (data: string) => void
  onResize?: (cols: number, rows: number) => void
  /** 挂载后回调句柄，卸载时回调 null，便于父组件释放订阅。 */
  onReady?: (handle: TerminalHandle | null) => void
  className?: string
  theme?: ITheme
}

/** 终端视图入口；只负责渲染，不启动进程。 */
export function TerminalView({ onData, onResize, onReady, className, theme }: TerminalViewProps) {
  const hostRef = useRef<HTMLDivElement | null>(null)
  const callbacksRef = useRef({ onData, onResize, onReady })
  const themeRef = useRef(theme)

  useEffect(() => {
    callbacksRef.current = { onData, onResize, onReady }
    themeRef.current = theme
  }, [onData, onResize, onReady, theme])

  useEffect(() => {
    const host = hostRef.current
    if (!host) return undefined

    const terminal = new Terminal({
      convertEol: true,
      cursorBlink: true,
      fontSize: 12,
      fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
      ...(themeRef.current ? { theme: themeRef.current } : {}),
    })
    const fitAddon = new FitAddon()
    terminal.loadAddon(fitAddon)
    terminal.open(host)

    /** jsdom 或隐藏面板没有布局时 fit 会拿不到尺寸，忽略即可。 */
    function fit(): void {
      try {
        fitAddon.fit()
      } catch {
        // 没有可测量尺寸时保持 xterm 当前行列数。
      }
    }

    fit()
    const dataSubscription = terminal.onData((data) => callbacksRef.current.onData?.(data))
    const resizeSubscription = terminal.onResize(({ cols, rows }) =>
      callbacksRef.current.onResize?.(cols, rows),
    )
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(() => fit())
    observer?.observe(host)

    callbacksRef.current.onReady?.({
      write: (data) => terminal.write(data),
      fit,
      focus: () => terminal.focus(),
    })

    return () => {
      observer?.disconnect()
      dataSubscription.dispose()
      resizeSubscription.dispose()
      callbacksRef.current.onReady?.(null)
      terminal.dispose()
    }
  }, [])

  return (
    <div
      ref={hostRef}
      className={className ? `terminal-view ${className}` : "terminal-view"}
      data-testid="terminal-view"
    />
  )
}
