/**
 * 代码查看与编辑：透明的 textarea 叠在高亮层上，输入、选择、撤销与输入法都交给浏览器原生处理；
 * 高亮层只渲染可见的行，行号栏横向滚动时固定在左侧。高亮在输入停顿后异步刷新，
 * 还没刷新到的行先按纯文字显示，保证文字与光标始终对齐。
 */
import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react"
import { highlightLines, type HighlightToken } from "@pigcode/ui-primitives"

/** 编辑器属性。 */
export interface CodeEditorProps {
  value: string
  /** 高亮语言；null 时按纯文本显示。 */
  language: string | null
  readOnly?: boolean | undefined
  onChange?: ((value: string) => void) | undefined
  /** ⌘S / Ctrl+S。 */
  onSave?: (() => void) | undefined
  /** 打开时滚到并选中这一行（从 1 开始）。 */
  revealLine?: number | null | undefined
  label: string
}

const LINE_HEIGHT = 20
const PADDING = 10
const OVERSCAN = 20
/** 超过这个长度不做高亮：大文件逐字高亮太慢，纯文字依然可读可编辑。 */
const HIGHLIGHT_LIMIT = 400_000

/** 一行在等宽字体下的显示宽度：CJK 等宽字符按两格，制表符按 tabSize。 */
function columns(line: string, tabSize: number): number {
  let width = 0
  for (const char of line) {
    if (char === "\t") width += tabSize - (width % tabSize)
    else width += (char.codePointAt(0) ?? 0) >= 0x2e80 ? 2 : 1
  }
  return width
}

/** 文件主要用制表符缩进时，Tab 插入制表符，否则插入两个空格。 */
function indentUnit(text: string): string {
  const sample = text.slice(0, 20_000)
  const tabs = (sample.match(/^\t/gm) ?? []).length
  const spaces = (sample.match(/^ {2,}/gm) ?? []).length
  return tabs > spaces ? "\t" : "  "
}

/** 在光标处插入文字；用 execCommand 保留浏览器原生的撤销记录。 */
function insertText(element: HTMLTextAreaElement, text: string): void {
  if (!document.execCommand?.("insertText", false, text)) {
    element.setRangeText(text, element.selectionStart, element.selectionEnd, "end")
    element.dispatchEvent(new Event("input", { bubbles: true }))
  }
}

/** 渲染编辑器。 */
export function CodeEditor({
  value,
  language,
  readOnly = false,
  onChange,
  onSave,
  revealLine = null,
  label,
}: CodeEditorProps) {
  const scroller = useRef<HTMLDivElement | null>(null)
  const input = useRef<HTMLTextAreaElement | null>(null)
  const [scrollTop, setScrollTop] = useState(0)
  const [viewport, setViewport] = useState(0)
  const [tokens, setTokens] = useState<{ lines: HighlightToken[][]; texts: string[] } | null>(null)
  const lines = useMemo(() => value.split("\n"), [value])
  const tabSize = 4
  const width = useMemo(
    () => lines.reduce((max, line) => Math.max(max, columns(line, tabSize)), 0),
    [lines],
  )
  const gutterChars = String(lines.length).length
  const gutter = `calc(${gutterChars}ch + ${PADDING * 2 + 6}px)`

  // 高亮在停顿 120ms 后刷新；结果按行保存原文，与当前文字不一致的行先显示纯文字。
  useEffect(() => {
    if (!language || value.length > HIGHLIGHT_LIMIT) {
      setTokens(null)
      return undefined
    }
    let cancelled = false
    const timer = setTimeout(
      () => {
        void highlightLines(value, language).then((result) => {
          if (cancelled || !result) return
          setTokens({
            lines: result,
            texts: result.map((line) => line.map((token) => token.content).join("")),
          })
        })
      },
      tokens ? 120 : 0,
    )
    return () => {
      cancelled = true
      clearTimeout(timer)
    }
    // tokens 只用来决定首次高亮不等待，不需要随它重跑。
  }, [value, language])

  useEffect(() => {
    const element = scroller.current
    if (!element || typeof ResizeObserver === "undefined") return undefined
    const observer = new ResizeObserver(() => setViewport(element.clientHeight))
    observer.observe(element)
    setViewport(element.clientHeight)
    return () => observer.disconnect()
  }, [])

  // 带行号打开时滚到那一行，并把光标放到行首。
  useEffect(() => {
    if (!revealLine || !scroller.current || !input.current) return
    const line = Math.min(Math.max(1, revealLine), lines.length)
    scroller.current.scrollTop = Math.max(
      0,
      (line - 1) * LINE_HEIGHT - scroller.current.clientHeight / 3,
    )
    const offset = lines.slice(0, line - 1).reduce((sum, text) => sum + text.length + 1, 0)
    input.current.setSelectionRange(offset, offset + (lines[line - 1]?.length ?? 0))
    // 只在目标行变化时定位，编辑不应把视图拉回去。
  }, [revealLine])

  const height = viewport || 800
  const first = Math.max(0, Math.floor((scrollTop - PADDING) / LINE_HEIGHT) - OVERSCAN)
  const last = Math.min(lines.length, Math.ceil((scrollTop + height) / LINE_HEIGHT) + OVERSCAN)
  const indent = useMemo(() => indentUnit(value), [value])

  function onKeyDown(event: KeyboardEvent<HTMLTextAreaElement>): void {
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "s") {
      event.preventDefault()
      onSave?.()
      return
    }
    if (readOnly || event.nativeEvent.isComposing) return
    const element = event.currentTarget
    if (
      event.key === "Tab" &&
      !event.shiftKey &&
      !event.metaKey &&
      !event.ctrlKey &&
      !event.altKey
    ) {
      event.preventDefault()
      insertText(element, indent)
    } else if (event.key === "Enter" && !event.shiftKey && !event.metaKey && !event.ctrlKey) {
      // 换行时沿用当前行的缩进。
      const before = element.value.slice(0, element.selectionStart)
      const current = before.slice(before.lastIndexOf("\n") + 1)
      const leading = /^[\t ]*/.exec(current)?.[0] ?? ""
      if (!leading) return
      event.preventDefault()
      insertText(element, `\n${leading}`)
    }
  }

  return (
    <div
      ref={scroller}
      className="code-scroll"
      onScroll={(event) => setScrollTop(event.currentTarget.scrollTop)}
    >
      <div
        className="code-canvas"
        style={{
          height: lines.length * LINE_HEIGHT + PADDING * 2,
          minWidth: `calc(${gutter} + ${width}ch + ${PADDING * 4}px)`,
          tabSize,
          ["--code-gutter" as string]: gutter,
        }}
      >
        <div className="code-gutter" aria-hidden="true">
          {Array.from({ length: last - first }, (_unused, offset) => (
            <span key={first + offset} style={{ top: PADDING + (first + offset) * LINE_HEIGHT }}>
              {first + offset + 1}
            </span>
          ))}
        </div>
        <div
          className="code-layer"
          aria-hidden="true"
          style={{ top: PADDING + first * LINE_HEIGHT }}
        >
          {lines.slice(first, last).map((line, offset) => {
            const index = first + offset
            const highlightedLine =
              tokens && tokens.texts[index] === line ? tokens.lines[index] : null
            return (
              <div key={index} className="code-line">
                {highlightedLine
                  ? highlightedLine.map((token, at) => (
                      <span key={at} className="tok" style={token.style}>
                        {token.content}
                      </span>
                    ))
                  : line || "\u200b"}
              </div>
            )
          })}
        </div>
        <textarea
          ref={input}
          className="code-input"
          aria-label={label}
          value={value}
          readOnly={readOnly}
          spellCheck={false}
          autoCapitalize="off"
          autoComplete="off"
          autoCorrect="off"
          wrap="off"
          onChange={(event) => onChange?.(event.target.value)}
          onKeyDown={onKeyDown}
        />
      </div>
    </div>
  )
}
