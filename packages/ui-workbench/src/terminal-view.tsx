/** 终端视图：封装 xterm 实例、fit addon 与 resize observer。 */
import { useEffect, useRef } from "react"
import { FitAddon } from "@xterm/addon-fit"
import { Terminal, type ITheme } from "@xterm/xterm"
import "@xterm/xterm/css/xterm.css"
import { documentTokenReader, resolveCssColor } from "@pigcode/ui-primitives"
import { terminalTheme } from "./terminal-theme"

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

/** 未传 theme 时按 <html> 上当前的 --term-* token 生成配色，外观设置的内联覆盖也算在内。 */
function documentTheme(): ITheme {
  return terminalTheme(documentTokenReader(), resolveCssColor)
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
      fontSize: 13,
      fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
      theme: themeRef.current ?? documentTheme(),
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
    // 外部没有指定配色时，明暗切换和外观设置改写 <html> 上的 token 后终端跟着换；
    // 拖动取色器时每次都会触发，所以只在配色真的变了时才交给 xterm 重绘。
    let appliedTheme = JSON.stringify(terminal.options.theme)
    const themeObserver =
      typeof MutationObserver === "undefined"
        ? null
        : new MutationObserver(() => {
            if (themeRef.current) return
            const next = documentTheme()
            const key = JSON.stringify(next)
            if (key === appliedTheme) return
            appliedTheme = key
            terminal.options.theme = next
          })
    themeObserver?.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["style", "data-theme"],
    })

    callbacksRef.current.onReady?.({
      write: (data) => terminal.write(data),
      fit,
      focus: () => terminal.focus(),
    })

    return () => {
      observer?.disconnect()
      themeObserver?.disconnect()
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
