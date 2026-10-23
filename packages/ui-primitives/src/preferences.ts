/** 跨页面共享、保存在本机的界面偏好；设置页与侧栏读写同一份。 */
import { useSyncExternalStore } from "react"

/** 侧栏会话的排法：按项目分组，或所有会话按最近更新排成一列。 */
export type SidebarGrouping = "project" | "time"

const GROUPING_KEY = "pigcode.sidebarGrouping"
const listeners = new Set<() => void>()

function readGrouping(): SidebarGrouping {
  try {
    return window.localStorage.getItem(GROUPING_KEY) === "time" ? "time" : "project"
  } catch {
    return "project"
  }
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  window.addEventListener("storage", listener)
  return () => {
    listeners.delete(listener)
    window.removeEventListener("storage", listener)
  }
}

/** 保存侧栏排法并通知所有读取方。 */
export function setSidebarGrouping(value: SidebarGrouping): void {
  try {
    window.localStorage.setItem(GROUPING_KEY, value)
  } catch {
    // 存储不可用时只在本次运行内生效。
  }
  for (const listener of listeners) listener()
}

/** 读取侧栏排法；任何一处修改后所有使用者一起更新。 */
export function useSidebarGrouping(): [SidebarGrouping, (value: SidebarGrouping) => void] {
  const value = useSyncExternalStore(subscribe, readGrouping, () => "project" as const)
  return [value, setSidebarGrouping]
}
