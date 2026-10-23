/** 终端视图：封装 xterm 实例、fit addon 与 resize observer。 */
import { useEffect, useRef } from "react"
import { FitAddon } from "@xterm/addon-fit"
import { Terminal, type ITheme } from "@xterm/xterm"
import "@xterm/xterm/css/xterm.css"

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

/**
 * 未传 theme 时按 html[data-theme] 选用的配色；背景与前景和 tokens.css 的 --term-bg / --term-fg 一致，
 * 改动时两边同步。
 */
export const TERMINAL_THEMES: Record<"light" | "dark", ITheme> = {
  light: {
    background: "#ffffff",
    foreground: "#27272a",
    cursor: "#3b5bdb",
    cursorAccent: "#ffffff",
    selectionBackground: "#3b5bdb2e",
    black: "#27272a",
    red: "#d1364b",
    green: "#1f8a4c",
    yellow: "#a86a00",
    blue: "#3463d6",
    magenta: "#8a3fd1",
    cyan: "#0f7f8f",
    white: "#6b6b7b",
    brightBlack: "#8b8b9a",
    brightRed: "#e5485d",
    brightGreen: "#2aa160",
    brightYellow: "#c27d00",
    brightBlue: "#4b78ea",
    brightMagenta: "#a259e6",
    brightCyan: "#1496a8",
    brightWhite: "#3a3a48",
  },
  dark: {
    background: "#161616",
    foreground: "#e4e4e7",
    cursor: "#7c93f2",
    cursorAccent: "#161616",
    selectionBackground: "#7c93f240",
    black: "#2c2c38",
    red: "#ff6b7d",
    green: "#5fd38d",
    yellow: "#f2c35b",
    blue: "#7aa2ff",
    magenta: "#c79bff",
    cyan: "#5ccfe0",
    white: "#c8c8d4",
    brightBlack: "#6b6b7d",
    brightRed: "#ff8a98",
    brightGreen: "#7fe3a5",
    brightYellow: "#ffd47a",
    brightBlue: "#9ab9ff",
    brightMagenta: "#dab8ff",
    brightCyan: "#7fdeec",
    brightWhite: "#f4f4f8",
  },
}

/** 读取当前界面明暗；没有 DOM 时按浅色处理。 */
function documentTheme(): ITheme {
  if (typeof document === "undefined") return TERMINAL_THEMES.light
  return document.documentElement.dataset.theme === "dark"
    ? TERMINAL_THEMES.dark
    : TERMINAL_THEMES.light
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
    // 外部没有指定配色时，界面切换明暗后终端跟着换。
    const themeObserver =
      typeof MutationObserver === "undefined"
        ? null
        : new MutationObserver(() => {
            if (!themeRef.current) terminal.options.theme = documentTheme()
          })
    themeObserver?.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["data-theme"],
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
