/**
 * 侧栏与右栏的宽度：限制在各自的范围内并记住；分隔条可拖动、用方向键微调、Home/End 到两端、双击复位，
 * 拖动中按 Esc 退回拖动前的宽度。拖动时窗口上盖一层透明遮罩，同 Cursor。
 */
import {
  useEffect,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
} from "react"
import { createPortal } from "react-dom"
import { useLocale } from "@pigcode/ui-primitives"

/** 一块可调宽度的面板：范围、默认宽度与保存的位置；最大宽度可以随窗口变化。 */
interface PanelWidth {
  min: number
  initial: number
  max: () => number
  storageKey: string
}

/** 侧栏：范围与 Cursor 的侧栏相同，默认宽度与 tokens.css 的 --sidebar-w 相同。 */
const SIDEBAR: PanelWidth = {
  min: 210,
  initial: 260,
  max: () => 400,
  storageKey: "pigcode.sidebarWidth",
}

/** 右栏：最宽占窗口的 58%，默认宽度与 tokens.css 的 --right-w 相同。 */
const RIGHT: PanelWidth = {
  min: 320,
  initial: 460,
  max: () =>
    Math.max(320, Math.round((typeof window === "undefined" ? 1200 : window.innerWidth) * 0.58)),
  storageKey: "pigcode.rightWidth",
}

/** 方向键一次调整的宽度。 */
const KEY_STEP = 24

function clampWidth(panel: PanelWidth, width: number): number {
  return Math.min(panel.max(), Math.max(panel.min, Math.round(width)))
}

/** 读取上次保存的宽度；存储不可用时回到默认值。 */
function savedWidth(panel: PanelWidth): number {
  try {
    const saved = Number.parseInt(window.localStorage.getItem(panel.storageKey) ?? "", 10)
    if (Number.isFinite(saved)) return clampWidth(panel, saved)
  } catch {
    // 隐私模式或测试环境可能禁用 localStorage；使用默认宽度。
  }
  return panel.initial
}

/** 面板宽度；记住上次的值，窗口变窄时重新夹紧，避免挤掉主内容。 */
function usePanelWidth(panel: PanelWidth): [number, (width: number) => void] {
  const [width, setWidth] = useState(() => savedWidth(panel))

  useEffect(() => {
    try {
      window.localStorage.setItem(panel.storageKey, String(width))
    } catch {
      // 存储不可用时不阻塞界面。
    }
  }, [panel, width])

  useEffect(() => {
    function handleResize(): void {
      setWidth((current) => clampWidth(panel, current))
    }
    window.addEventListener("resize", handleResize)
    return () => window.removeEventListener("resize", handleResize)
  }, [panel])

  return [width, (next) => setWidth(clampWidth(panel, next))]
}

/** 侧栏宽度；工作区侧栏与设置侧栏共用。 */
export function useSidebarWidth(): [number, (width: number) => void] {
  return usePanelWidth(SIDEBAR)
}

/** 右栏宽度。 */
export function useRightWidth(): [number, (width: number) => void] {
  return usePanelWidth(RIGHT)
}

interface ResizerProps {
  panel: PanelWidth
  /** 分隔条在面板的哪一边：往这一边拖、按这一边的方向键时面板变宽。 */
  edge: "left" | "right"
  label: string
  className: string
  width: number
  onChange: (width: number) => void
}

function Resizer({ panel, edge, label, className, width, onChange }: ResizerProps) {
  const [dragging, setDragging] = useState(false)
  const endDrag = useRef<(() => void) | null>(null)
  const grow = edge === "right" ? 1 : -1

  // 拖动中被卸载（例如拖着时按 ⌘B 收起侧栏）也要收掉监听和遮罩。
  useEffect(() => () => endDrag.current?.(), [])

  function startResize(event: ReactPointerEvent<HTMLDivElement>): void {
    if (event.button !== 0) return
    event.preventDefault()
    endDrag.current?.()
    const startX = event.clientX
    const startWidth = width
    let moved = false
    const move = (moveEvent: PointerEvent): void => {
      // 指针真的动了才盖遮罩（同 Cursor）：只是单击、双击时不盖，双击复位才落得到分隔条上。
      if (!moved) {
        if (moveEvent.clientX === startX) return
        moved = true
        setDragging(true)
      }
      onChange(startWidth + (moveEvent.clientX - startX) * grow)
    }
    const cancel = (keyEvent: KeyboardEvent): void => {
      if (keyEvent.key !== "Escape") return
      keyEvent.preventDefault()
      keyEvent.stopPropagation()
      onChange(startWidth)
      stop()
    }
    const stop = (): void => {
      window.removeEventListener("pointermove", move)
      window.removeEventListener("pointerup", stop)
      window.removeEventListener("pointercancel", stop)
      window.removeEventListener("blur", stop)
      window.removeEventListener("keydown", cancel, true)
      document.body.classList.remove("is-resizing")
      endDrag.current = null
      setDragging(false)
    }
    endDrag.current = stop
    window.addEventListener("pointermove", move)
    window.addEventListener("pointerup", stop)
    window.addEventListener("pointercancel", stop)
    window.addEventListener("blur", stop)
    // 拖动中的 Esc 只取消这次拖动，不再传给别的快捷键。
    window.addEventListener("keydown", cancel, true)
    // 按下就让 webview 与 iframe 不接指针：遮罩盖上之前的第一下移动落在内置浏览器上，也不会被它吞掉。
    document.body.classList.add("is-resizing")
  }

  function onKeyDown(event: ReactKeyboardEvent<HTMLDivElement>): void {
    const targets: Partial<Record<string, number>> = {
      ArrowRight: width + KEY_STEP * grow,
      ArrowLeft: width - KEY_STEP * grow,
      Home: panel.min,
      End: panel.max(),
    }
    const next = targets[event.key]
    if (next === undefined) return
    event.preventDefault()
    onChange(next)
  }

  return (
    <>
      <div
        className={className}
        role="separator"
        aria-orientation="vertical"
        aria-label={label}
        aria-valuemin={panel.min}
        aria-valuemax={panel.max()}
        aria-valuenow={width}
        tabIndex={0}
        data-resizing={dragging || undefined}
        onPointerDown={startResize}
        onKeyDown={onKeyDown}
        onDoubleClick={() => onChange(panel.initial)}
      />
      {dragging
        ? createPortal(<div className="resize-overlay" aria-hidden="true" />, document.body)
        : null}
    </>
  )
}

/** 侧栏右边的分隔条；向右拖变宽。 */
export function SidebarResizer({
  width,
  onChange,
}: {
  width: number
  onChange: (width: number) => void
}) {
  const { t } = useLocale()
  return (
    <Resizer
      panel={SIDEBAR}
      edge="right"
      label={t("sidebar.resize")}
      className="panel-resizer sidebar-resizer"
      width={width}
      onChange={onChange}
    />
  )
}

/** 右栏左边的分隔条；向左拖变宽。 */
export function PanelResizer({
  width,
  onChange,
}: {
  width: number
  onChange: (width: number) => void
}) {
  const { t } = useLocale()
  return (
    <Resizer
      panel={RIGHT}
      edge="left"
      label={t("panel.label")}
      className="panel-resizer"
      width={width}
      onChange={onChange}
    />
  )
}
