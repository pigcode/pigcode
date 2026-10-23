/** 右栏宽度：限制在窗口可承受的范围内并记住；分隔条可拖动、用方向键微调、双击复位。 */
import {
  useEffect,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
} from "react"
import { useLocale } from "@pigcode/ui-primitives"

const RIGHT_MIN = 320
const RIGHT_DEFAULT = 460
const RIGHT_MAX_RATIO = 0.58
const RIGHT_STORAGE_KEY = "pigcode.rightWidth"

/** 把右栏宽度限制在窗口可承受范围内。 */
function clampRightWidth(width: number): number {
  const max = Math.max(
    RIGHT_MIN,
    Math.round((typeof window === "undefined" ? 1200 : window.innerWidth) * RIGHT_MAX_RATIO),
  )
  return Math.min(max, Math.max(RIGHT_MIN, Math.round(width)))
}

/** 读取上次保存的右栏宽度；存储不可用时回到默认值。 */
function initialRightWidth(): number {
  try {
    const saved = Number.parseInt(window.localStorage.getItem(RIGHT_STORAGE_KEY) ?? "", 10)
    if (Number.isFinite(saved)) return clampRightWidth(saved)
  } catch {
    // 隐私模式或测试环境可能禁用 localStorage；使用默认宽度。
  }
  return RIGHT_DEFAULT
}

/** 右栏宽度；记住上次的值，窗口变窄时重新夹紧，避免右栏挤掉主内容。 */
export function useRightWidth(): [number, (width: number) => void] {
  const [width, setWidth] = useState(initialRightWidth)

  useEffect(() => {
    try {
      window.localStorage.setItem(RIGHT_STORAGE_KEY, String(width))
    } catch {
      // 存储不可用时不阻塞界面。
    }
  }, [width])

  useEffect(() => {
    function handleResize(): void {
      setWidth((current) => clampRightWidth(current))
    }
    window.addEventListener("resize", handleResize)
    return () => window.removeEventListener("resize", handleResize)
  }, [])

  return [width, (next) => setWidth(clampRightWidth(next))]
}

/** 右栏左边的分隔条；向左拖变宽，向右拖变窄。 */
export function PanelResizer({
  width,
  onChange,
}: {
  width: number
  onChange: (width: number) => void
}) {
  const { t } = useLocale()

  function startResize(event: ReactPointerEvent<HTMLDivElement>): void {
    event.preventDefault()
    const startX = event.clientX
    const move = (moveEvent: PointerEvent): void => {
      onChange(width + startX - moveEvent.clientX)
    }
    const up = (): void => {
      window.removeEventListener("pointermove", move)
      window.removeEventListener("pointerup", up)
      document.body.classList.remove("is-resizing")
    }
    window.addEventListener("pointermove", move)
    window.addEventListener("pointerup", up)
    document.body.classList.add("is-resizing")
  }

  function onKeyDown(event: ReactKeyboardEvent<HTMLDivElement>): void {
    if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return
    event.preventDefault()
    onChange(width + (event.key === "ArrowLeft" ? 24 : -24))
  }

  return (
    <div
      className="panel-resizer"
      role="separator"
      aria-orientation="vertical"
      aria-label={t("panel.label")}
      aria-valuemin={RIGHT_MIN}
      aria-valuemax={clampRightWidth(Number.MAX_SAFE_INTEGER)}
      aria-valuenow={width}
      tabIndex={0}
      onPointerDown={startResize}
      onKeyDown={onKeyDown}
      onDoubleClick={() => onChange(RIGHT_DEFAULT)}
    />
  )
}
