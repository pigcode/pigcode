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
interface PanelSize {
  min: number
  initial: number
  max: () => number
}

interface PanelWidth extends PanelSize {
  storageKey: string
  /** 持久化值的静态上限；不随临时缩窄的窗口覆盖用户偏好。 */
  staticMax: number
}

/** 聊天区（主内容区）在侧栏或右栏并排停靠时保留的最小可读宽度。 */
const MIN_MAIN_WIDTH = 400
const RIGHT_MAX_RATIO = 0.58

/** 侧栏：范围与 Cursor 的侧栏相同，默认宽度与 tokens.css 的 --sidebar-w 相同。 */
const SIDEBAR: PanelWidth = {
  min: 210,
  initial: 260,
  max: () => 400,
  staticMax: 400,
  storageKey: "pigcode.sidebarWidth",
}

/** 右栏：最宽占窗口的 58%，默认宽度与 tokens.css 的 --right-w 相同。 */
const RIGHT: PanelWidth = {
  min: 320,
  initial: 460,
  max: () =>
    Math.max(
      320,
      Math.round((typeof window === "undefined" ? 1200 : window.innerWidth) * RIGHT_MAX_RATIO),
    ),
  staticMax: 1600,
  storageKey: "pigcode.rightWidth",
}

/** 方向键一次调整的宽度。 */
const KEY_STEP = 24

function clampRange(min: number, max: number, width: number): number {
  const upper = Math.max(min, max)
  return Math.min(upper, Math.max(min, Math.round(width)))
}

function clampWidth(panel: PanelSize, width: number): number {
  return clampRange(panel.min, panel.max(), width)
}

function currentViewportWidth(): number {
  return typeof window === "undefined" ? 1200 : window.innerWidth
}

/** 读取上次保存的偏好宽度；只按静态上下限夹紧，避免窄窗启动时把用户偏好覆盖掉。 */
function savedWidth(panel: PanelWidth): number {
  try {
    const saved = Number.parseInt(window.localStorage.getItem(panel.storageKey) ?? "", 10)
    if (Number.isFinite(saved)) return clampRange(panel.min, panel.staticMax, saved)
  } catch {
    // 隐私模式或测试环境可能禁用 localStorage；使用默认宽度。
  }
  return panel.initial
}

function persistWidth(storageKey: string, width: number): void {
  try {
    window.localStorage.setItem(storageKey, String(width))
  } catch {
    // 存储不可用时不阻塞界面。
  }
}

/** 根据当前视口宽度和并排停靠状态计算侧栏与右栏的有效宽度和上限，始终为主内容区留出最小宽度。 */
export function resolveShellPanelWidths({
  viewportWidth,
  preferredSidebar,
  preferredRight,
  sidebarDocked,
  rightDocked,
}: {
  viewportWidth: number
  preferredSidebar: number
  preferredRight: number
  sidebarDocked: boolean
  rightDocked: boolean
}): {
  sidebarWidth: number
  sidebarMax: number
  rightWidth: number
  rightMax: number
} {
  const sidebarReserve = rightDocked ? MIN_MAIN_WIDTH + RIGHT.min : MIN_MAIN_WIDTH
  const sidebarMax = sidebarDocked
    ? Math.min(SIDEBAR.staticMax, Math.max(SIDEBAR.min, viewportWidth - sidebarReserve))
    : SIDEBAR.staticMax
  const sidebarWidth = clampRange(SIDEBAR.min, sidebarMax, preferredSidebar)

  const workspaceWidth = viewportWidth - (sidebarDocked ? sidebarWidth : 0)
  const ratioCap = Math.round(viewportWidth * RIGHT_MAX_RATIO)
  const spaceCap = workspaceWidth - MIN_MAIN_WIDTH
  const rightMax = Math.max(RIGHT.min, Math.min(ratioCap, spaceCap))
  const rightWidth = clampRange(RIGHT.min, rightMax, preferredRight)

  return { sidebarWidth, sidebarMax, rightWidth, rightMax }
}

/** 跟随窗口 resize 的视口宽度。 */
function useViewportWidth(): number {
  const [viewportWidth, setViewportWidth] = useState(currentViewportWidth)

  useEffect(() => {
    function handleResize(): void {
      setViewportWidth(currentViewportWidth())
    }
    window.addEventListener("resize", handleResize)
    return () => window.removeEventListener("resize", handleResize)
  }, [])

  return viewportWidth
}

/**
 * 侧栏与右栏联合自适应宽度：
 * 用户拖拽/键盘/双击改的是偏好宽度并持久化；窗口缩窄时按当前视口实时让步，
 * 不会把临时缩小后的值写回存储，窗口拉宽后自动恢复到用户原本的宽度。
 */
export function useShellPanelWidths({
  sidebarDocked,
  rightDocked,
}: {
  sidebarDocked: boolean
  rightDocked: boolean
}): {
  sidebarWidth: number
  sidebarMax: number
  setSidebarWidth: (width: number) => void
  rightWidth: number
  rightMax: number
  setRightWidth: (width: number) => void
} {
  const viewportWidth = useViewportWidth()
  const [preferredSidebar, setPreferredSidebar] = useState(() => savedWidth(SIDEBAR))
  const [preferredRight, setPreferredRight] = useState(() => savedWidth(RIGHT))

  const resolved = resolveShellPanelWidths({
    viewportWidth,
    preferredSidebar,
    preferredRight,
    sidebarDocked,
    rightDocked,
  })

  function setSidebarWidth(next: number): void {
    const clamped = clampRange(SIDEBAR.min, resolved.sidebarMax, next)
    setPreferredSidebar(clamped)
    persistWidth(SIDEBAR.storageKey, clamped)
  }

  function setRightWidth(next: number): void {
    const clamped = clampRange(RIGHT.min, resolved.rightMax, next)
    setPreferredRight(clamped)
    persistWidth(RIGHT.storageKey, clamped)
  }

  return {
    ...resolved,
    setSidebarWidth,
    setRightWidth,
  }
}

/** 面板宽度；记住上次的值，窗口变窄时只临时夹紧，不覆盖已保存的用户偏好。 */
function usePanelWidth(panel: PanelWidth): [number, (width: number) => void] {
  useViewportWidth()
  const [preferred, setPreferred] = useState(() => savedWidth(panel))
  const effective = clampWidth(panel, preferred)

  return [
    effective,
    (next) => {
      const clamped = clampWidth(panel, next)
      setPreferred(clamped)
      persistWidth(panel.storageKey, clamped)
    },
  ]
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
  panel: PanelSize
  /** 分隔条在面板的哪一边：往这一边拖、按这一边的方向键时面板变宽。 */
  edge: "left" | "right"
  label: string
  className: string
  width: number
  onChange: (width: number) => void
}

/** 可拖动、用键盘调整或双击复位的面板分隔条。 */
export function Resizer({ panel, edge, label, className, width, onChange }: ResizerProps) {
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
  max,
  onChange,
}: {
  width: number
  max?: number
  onChange: (width: number) => void
}) {
  const { t } = useLocale()
  const panel: PanelSize = max === undefined ? SIDEBAR : { ...SIDEBAR, max: () => max }
  return (
    <Resizer
      panel={panel}
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
  max,
  onChange,
}: {
  width: number
  max?: number
  onChange: (width: number) => void
}) {
  const { t } = useLocale()
  const panel: PanelSize = max === undefined ? RIGHT : { ...RIGHT, max: () => max }
  return (
    <Resizer
      panel={panel}
      edge="left"
      label={t("panel.label")}
      className="panel-resizer"
      width={width}
      onChange={onChange}
    />
  )
}
