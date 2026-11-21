/**
 * 地址里的原型状态：方案、界面、会话、连接状态和主题。方案和连接状态的切换替换当前地址，
 * 界面里的前进用 pushState，手机上的返回手势和浏览器后退都能退回上一屏。
 */
import { createContext, useCallback, useContext, useEffect, useRef, useState } from "react"

export type Variant = "A" | "B" | "C" | "D"
export type Conn = "online" | "reconnecting" | "offline"
export type Theme = "system" | "light" | "dark"
export type Screen = "list" | "inbox" | "thread" | "diff" | "new" | "computer" | "pair"

export const VARIANTS: Array<{ key: Variant; name: string }> = [
  { key: "A", name: "收件箱" },
  { key: "B", name: "按项目 + 标签栏" },
  { key: "C", name: "对话优先" },
  { key: "D", name: "对话优先 + 桌面式菜单" },
]

export interface Place {
  screen: Screen
  thread?: string | undefined
  file?: string | undefined
  /** 新会话预先选好的项目（从项目行的「+」进来）。 */
  project?: string | undefined
}

export interface UrlState extends Place {
  variant: Variant
  conn: Conn
  theme: Theme
}

const SCREENS: Screen[] = ["list", "inbox", "thread", "diff", "new", "computer", "pair"]

function pick<T extends string>(value: string | null, allowed: readonly T[], fallback: T): T {
  return allowed.includes(value as T) ? (value as T) : fallback
}

function read(): UrlState {
  const params = new URLSearchParams(window.location.search)
  return {
    variant: pick(params.get("v"), ["A", "B", "C", "D"], "D"),
    conn: pick(params.get("c"), ["online", "reconnecting", "offline"], "online"),
    theme: pick(params.get("theme"), ["system", "light", "dark"], "system"),
    screen: pick(params.get("s"), SCREENS, "thread"),
    thread: params.get("t") ?? undefined,
    file: params.get("f") ?? undefined,
    project: params.get("p") ?? undefined,
  }
}

function write(state: UrlState, push: boolean): void {
  const params = new URLSearchParams()
  params.set("v", state.variant)
  params.set("s", state.screen)
  if (state.thread) params.set("t", state.thread)
  if (state.file) params.set("f", state.file)
  if (state.project) params.set("p", state.project)
  if (state.conn !== "online") params.set("c", state.conn)
  if (state.theme !== "system") params.set("theme", state.theme)
  const url = `${window.location.pathname}?${params.toString()}`
  if (push) window.history.pushState({ inApp: true }, "", url)
  else window.history.replaceState(window.history.state, "", url)
}

/** 读写地址里的原型状态。 */
export function useUrlState(): [UrlState, (patch: Partial<UrlState>, push?: boolean) => void] {
  const [state, setState] = useState(read)
  const current = useRef(state)
  current.current = state

  useEffect(() => {
    write(current.current, false)
    // 后退只恢复停在哪一屏；方案、连接状态和主题保持现在的，切过方案后退不会跳回原来那套。
    const onPop = () => {
      const { variant, conn, theme } = current.current
      const next = { ...read(), variant, conn, theme }
      current.current = next
      write(next, false)
      setState(next)
    }
    window.addEventListener("popstate", onPop)
    return () => window.removeEventListener("popstate", onPop)
  }, [])

  const update = useCallback((patch: Partial<UrlState>, push = false) => {
    const next = { ...current.current, ...patch }
    current.current = next
    write(next, push)
    setState(next)
  }, [])

  return [state, update]
}

export interface Nav {
  place: Place
  conn: Conn
  variant: Variant
  /** 前进到另一屏。 */
  go: (place: Place) => void
  /** 换掉当前这一屏，不留历史。 */
  replace: (place: Place) => void
  /** 退回上一屏；没有上一屏时去 fallback。 */
  back: (fallback: Place) => void
}

export const NavContext = createContext<Nav | null>(null)

export function useNav(): Nav {
  const nav = useContext(NavContext)
  if (!nav) throw new Error("useNav must be used inside NavContext")
  return nav
}
