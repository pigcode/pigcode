/** 前进后退的历史：会话、设置分区与插件页都是可以回去的位置。 */
import type { SettingsSection } from "@pigcode/ui-shell"

/** 一个可以回去的位置。 */
export type NavLocation =
  | { kind: "thread"; threadId: string }
  | { kind: "settings"; section: SettingsSection }
  | { kind: "plugins" }

/** 历史记录与当前所在的下标；没有记录时 index 为 -1。 */
export interface NavHistory {
  entries: NavLocation[]
  index: number
}

export const EMPTY_HISTORY: NavHistory = { entries: [], index: -1 }

/** 最多保留的历史条数；超出时丢弃最早的。 */
const MAX_ENTRIES = 50

/** 两个位置是否相同。 */
export function sameLocation(a: NavLocation | null, b: NavLocation | null): boolean {
  if (!a || !b || a.kind !== b.kind) return false
  if (a.kind === "thread" && b.kind === "thread") return a.threadId === b.threadId
  if (a.kind === "settings" && b.kind === "settings") return a.section === b.section
  return true
}

/** 当前位置；没有记录时为 null。 */
export function currentLocation(history: NavHistory): NavLocation | null {
  return history.entries[history.index] ?? null
}

/** 记录一次导航：与当前位置相同时不变；否则丢掉前进分支再追加。 */
export function pushLocation(history: NavHistory, location: NavLocation): NavHistory {
  if (sameLocation(currentLocation(history), location)) return history
  const entries = [...history.entries.slice(0, history.index + 1), location].slice(-MAX_ENTRIES)
  return { entries, index: entries.length - 1 }
}

/** 删除已经失效的位置（例如归档后的会话），下标跟着原来的位置走。 */
export function pruneHistory(
  history: NavHistory,
  isValid: (location: NavLocation) => boolean,
): NavHistory {
  const entries: NavLocation[] = []
  let index = -1
  history.entries.forEach((location, position) => {
    if (!isValid(location)) return
    const previous = entries.at(-1) ?? null
    if (!sameLocation(previous, location)) entries.push(location)
    if (position <= history.index) index = entries.length - 1
  })
  return { entries, index: entries.length === 0 ? -1 : Math.max(index, 0) }
}

export function canGoBack(history: NavHistory): boolean {
  return history.index > 0
}

export function canGoForward(history: NavHistory): boolean {
  return history.index >= 0 && history.index < history.entries.length - 1
}

/** 后退一步；已经在最早的位置时不变。 */
export function goBack(history: NavHistory): NavHistory {
  return canGoBack(history) ? { ...history, index: history.index - 1 } : history
}

/** 前进一步；已经在最新的位置时不变。 */
export function goForward(history: NavHistory): NavHistory {
  return canGoForward(history) ? { ...history, index: history.index + 1 } : history
}
