/** 文件导航的折叠、停靠和宽度。较窄的面板在目录与预览间切换。 */
import { useCallback, useLayoutEffect, useState } from "react"

const OPEN_KEY = "pigcode.files.explorerOpen"
const WIDTH_KEY = "pigcode.files.explorerWidth"
const MIN_SPLIT = 384
const MIN_WIDTH = 160
const DEFAULT_WIDTH = 192

function readPreference(key: string): string | null {
  try {
    return window.localStorage.getItem(key)
  } catch {
    return null
  }
}

function savePreference(key: string, value: boolean | number): void {
  try {
    window.localStorage.setItem(key, String(value))
  } catch {
    // 存储不可用时本次仍可调整。
  }
}

/** 宽面板使用双列，窄面板给文件导航和内容各自的完整宽度。 */
export function useFileNavigation(hasFile: boolean) {
  const [element, setElement] = useState<HTMLDivElement | null>(null)
  const [available, setAvailable] = useState(460)
  const [preferredOpen, setPreferredOpen] = useState(() => readPreference(OPEN_KEY) !== "false")
  const [narrowOpen, setNarrowOpen] = useState<boolean | null>(null)
  const [preferredWidth, setPreferredWidth] = useState(() => {
    const width = Number.parseInt(readPreference(WIDTH_KEY) ?? "", 10)
    return Number.isFinite(width) ? width : DEFAULT_WIDTH
  })

  useLayoutEffect(() => {
    if (!element || typeof ResizeObserver === "undefined") return
    const measure = () => {
      if (element.clientWidth > 0) setAvailable(element.clientWidth)
    }
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(element)
    return () => observer.disconnect()
  }, [element])

  const docked = available >= MIN_SPLIT
  const max = Math.max(MIN_WIDTH, Math.floor(available * 0.6))
  const clamp = (width: number) => Math.min(max, Math.max(MIN_WIDTH, Math.round(width)))
  const open = docked ? preferredOpen : (narrowOpen ?? !hasFile)

  const show = useCallback(
    (next: boolean) => {
      if (docked) {
        setPreferredOpen(next)
        savePreference(OPEN_KEY, next)
      } else {
        setNarrowOpen(next)
      }
    },
    [docked],
  )

  return {
    ref: setElement,
    open,
    docked,
    width: clamp(preferredWidth),
    resizer: { min: MIN_WIDTH, initial: DEFAULT_WIDTH, max: () => max },
    show,
    selectFile: () => setNarrowOpen(false),
    resize: (width: number) => {
      const next = clamp(width)
      setPreferredWidth(next)
      savePreference(WIDTH_KEY, next)
    },
  }
}
