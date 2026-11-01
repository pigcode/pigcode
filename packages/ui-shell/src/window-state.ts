/** 外壳依赖的窗口与平台状态：原生平台、标题栏形态、窄窗口、历史与会话快捷键。 */
import { useEffect, useState } from "react"
import { isMacPlatform } from "@pigcode/ui-primitives"

type ModifierEvent = Pick<KeyboardEvent, "metaKey" | "ctrlKey" | "altKey" | "shiftKey">

/** 只按着 ⌘（macOS）或 Ctrl（Windows、Linux），没有其他修饰键。 */
function onlyPrimaryModifier(event: ModifierEvent, mac: boolean): boolean {
  if (event.altKey || event.shiftKey) return false
  return mac ? event.metaKey && !event.ctrlKey : event.ctrlKey && !event.metaKey
}

/** ⌘1…⌘9（macOS）或 Ctrl+1…Ctrl+9 对应的位置，从 1 开始；按物理键判断，不受键盘布局影响。 */
export function threadShortcutIndex(
  event: ModifierEvent & Pick<KeyboardEvent, "code">,
  mac: boolean = isMacPlatform(),
): number | null {
  const digit = /^Digit([1-9])$/.exec(event.code)
  return digit && onlyPrimaryModifier(event, mac) ? Number(digit[1]) : null
}

/**
 * 单独按住 ⌘（macOS）或 Ctrl 片刻后为 true，用来在会话上显示数字快捷键；
 * 松开、窗口失焦或按下数字以外的键时复位，避免 ⌘K 之类的组合键闪出提示。
 */
export function useModifierHints(delay = 450, mac: boolean = isMacPlatform()): boolean {
  const [visible, setVisible] = useState(false)
  useEffect(() => {
    const modifier = mac ? "Meta" : "Control"
    let timer: ReturnType<typeof setTimeout> | undefined
    const reset = (): void => {
      clearTimeout(timer)
      timer = undefined
      setVisible(false)
    }
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === modifier) {
        timer ??= setTimeout(() => setVisible(true), delay)
        return
      }
      if (threadShortcutIndex(event, mac) === null) reset()
    }
    const onKeyUp = (event: KeyboardEvent): void => {
      if (event.key === modifier) reset()
    }
    window.addEventListener("keydown", onKeyDown)
    window.addEventListener("keyup", onKeyUp)
    window.addEventListener("blur", reset)
    return () => {
      clearTimeout(timer)
      window.removeEventListener("keydown", onKeyDown)
      window.removeEventListener("keyup", onKeyUp)
      window.removeEventListener("blur", reset)
    }
  }, [delay, mac])
  return visible
}

/** 原生桥报告的平台；浏览器与测试环境里为空字符串。 */
export function nativePlatform(): string {
  return typeof window === "undefined" ? "" : (window.pigcodeNative?.platform ?? "")
}

/** Windows 与 Linux 由页面绘制标题栏，系统窗口按钮叠在它上面。 */
export function hasCustomTitleBar(platform: string): boolean {
  return platform === "win32" || platform === "linux"
}

/** ⌘[ / ⌘]（macOS）或 Alt+← / Alt+→（Windows、Linux）对应的历史方向。 */
export function historyStep(
  event: Pick<KeyboardEvent, "key" | "metaKey" | "ctrlKey" | "altKey" | "shiftKey">,
  mac: boolean = isMacPlatform(),
): "back" | "forward" | null {
  if (mac) {
    if (!event.metaKey || event.ctrlKey || event.altKey || event.shiftKey) return null
    return event.key === "[" ? "back" : event.key === "]" ? "forward" : null
  }
  if (!event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return null
  return event.key === "ArrowLeft" ? "back" : event.key === "ArrowRight" ? "forward" : null
}

/** 与 sidebar.css、workspace.css 的窄窗口断点一致：更窄时侧栏改成浮在内容上的抽屉。 */
const NARROW_QUERY = "(max-width: 960px)"

function matchesNarrow(): boolean {
  return typeof window !== "undefined" && typeof window.matchMedia === "function"
    ? window.matchMedia(NARROW_QUERY).matches
    : false
}

/** 窗口是否窄到侧栏改成抽屉。 */
export function useNarrowWindow(): boolean {
  const [narrow, setNarrow] = useState(matchesNarrow)
  useEffect(() => {
    if (typeof window.matchMedia !== "function") return
    const list = window.matchMedia(NARROW_QUERY)
    const onChange = (event: MediaQueryListEvent): void => setNarrow(event.matches)
    list.addEventListener("change", onChange)
    return () => list.removeEventListener("change", onChange)
  }, [])
  return narrow
}
