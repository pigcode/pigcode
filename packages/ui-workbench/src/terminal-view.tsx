/** 终端视图：封装 xterm 实例、fit addon 与 resize observer。 */
import { useEffect, useRef } from "react"
import { FitAddon } from "@xterm/addon-fit"
import { WebglAddon } from "@xterm/addon-webgl"
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

/**
 * 挂在宿主元素上的只读探针：WebGL 把字画在画布上，DOM 里读不到终端内容，
 * 调试与 E2E 通过它读当前的文字和配色。
 */
export interface TerminalProbe {
  /** 缓冲区里全部行的文字，行尾空白去掉。 */
  text(): string
  /** xterm 正在用的配色。 */
  theme(): ITheme
}

/** 带探针的宿主元素。 */
export type TerminalHost = HTMLDivElement & { pigcodeTerminal?: TerminalProbe }

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

/**
 * 用 WebGL 画终端（和 VS Code、Cursor 的终端一样）：每一格按网格坐标画，长行不会因为字宽的小数
 * 一格格累积往右偏，方框字符（╮ ╯ ─）与提示符的色块由 xterm 自己画，接缝对齐。
 * 拿不到 WebGL 或 GPU 上下文丢了（同时开太多终端、显卡重置）时退回 DOM 渲染。返回释放函数。
 */
function useWebgl(terminal: Terminal): () => void {
  let addon: WebglAddon | null = null
  try {
    addon = new WebglAddon()
    addon.onContextLoss(() => {
      addon?.dispose()
      addon = null
    })
    terminal.loadAddon(addon)
  } catch {
    addon?.dispose()
    addon = null
  }
  return () => {
    addon?.dispose()
    addon = null
  }
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
    const disposeWebgl = useWebgl(terminal)
    ;(host as TerminalHost).pigcodeTerminal = {
      text: () => {
        const buffer = terminal.buffer.active
        const lines: string[] = []
        for (let row = 0; row < buffer.length; row += 1) {
          lines.push(buffer.getLine(row)?.translateToString(true) ?? "")
        }
        return lines.join("\n").trimEnd()
      },
      theme: () => ({ ...terminal.options.theme }),
    }

    /** jsdom 或隐藏面板没有布局时 fit 会拿不到尺寸，忽略即可。 */
    function fit(): void {
      try {
        fitAddon.fit()
      } catch {
        // 没有可测量尺寸时保持 xterm 当前行列数。
      }
    }

    // 先订阅再 fit：第一次 fit 的尺寸变化也要报出去，否则 PTY 一直以为自己是 80×24，
    // 直到面板尺寸再变一次（换行宽度不对，全屏程序的底部落在可见区域外面）。
    // 调用方等第一次尺寸报告再启动 shell，所以面板有了布局以后一定要报一次：
    // fit 量出来正好等于 xterm 的初始行列数时不会触发 onResize，这时主动报。
    let reported = false
    const dataSubscription = terminal.onData((data) => callbacksRef.current.onData?.(data))
    const resizeSubscription = terminal.onResize(({ cols, rows }) => {
      reported = true
      callbacksRef.current.onResize?.(cols, rows)
    })
    /** 面板还没有布局（藏在 display: none 里）时量不出尺寸，等它显示出来再报。 */
    function fitAndReport(): void {
      fit()
      if (reported || host?.clientWidth === 0 || host?.clientHeight === 0) return
      reported = true
      callbacksRef.current.onResize?.(terminal.cols, terminal.rows)
    }
    fitAndReport()
    const observer =
      typeof ResizeObserver === "undefined" ? null : new ResizeObserver(() => fitAndReport())
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
      disposeWebgl()
      delete (host as TerminalHost).pigcodeTerminal
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
