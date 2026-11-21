/** 跨页面共享、保存在本机的界面偏好；设置页与侧栏读写同一份。 */
import { useSyncExternalStore } from "react"

/** 侧栏会话的分组：按项目，按更新时间分成今天、昨天……，或者按状态分成需要处理、出错……。 */
export type SidebarGrouping = "project" | "time" | "status"

const GROUPING_KEY = "pigcode.sidebarGrouping"
const listeners = new Set<() => void>()

function readGrouping(): SidebarGrouping {
  try {
    const value = window.localStorage.getItem(GROUPING_KEY)
    return value === "time" || value === "status" ? value : "project"
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

/** 按项目分组时项目的先后：手动是添加的先后（可以拖动调整），更新时间是按项目里最近更新的会话。 */
export type SidebarProjectOrder = "manual" | "updated"

/** 组里会话的先后：按更新时间，或者按状态（同一状态里按更新时间）。 */
export type SidebarThreadOrder = "updated" | "status"

/** 「筛选 ▸ 状态」的选项，也是按状态排序时的先后；未读是跑完了还没看的会话。 */
export const SIDEBAR_STATUS_FILTERS = [
  "attention",
  "error",
  "unread",
  "working",
  "draft",
  "done",
] as const
export type SidebarStatusFilter = (typeof SIDEBAR_STATUS_FILTERS)[number]

/** 侧栏的排序、会话行上显示什么和筛选。 */
export interface SidebarView {
  projectOrder: SidebarProjectOrder
  /** 手动排过的项目，从上到下；不在里面的项目按添加的先后排在后面。 */
  projectIds: string[]
  threadOrder: SidebarThreadOrder
  /** 会话行右侧显示更新时间。 */
  showTime: boolean
  /** 不按项目分组时会话行显示所属项目；按项目分组时项目就是分组，不再显示。 */
  showProject: boolean
  /** 只显示这些状态的会话；全部选上等于不筛，取消到一个不剩时回到全选。 */
  statusFilter: SidebarStatusFilter[]
  /** 只看已归档的会话。 */
  archived: boolean
}

const VIEW_KEY = "pigcode.sidebarView"
export const DEFAULT_SIDEBAR_VIEW: SidebarView = {
  projectOrder: "manual",
  projectIds: [],
  threadOrder: "updated",
  showTime: true,
  showProject: false,
  statusFilter: [...SIDEBAR_STATUS_FILTERS],
  archived: false,
}
/** useSyncExternalStore 要求快照在存储没变时保持同一个对象。 */
let viewCache: { raw: string | null; value: SidebarView } = {
  raw: null,
  value: DEFAULT_SIDEBAR_VIEW,
}

/** 状态筛选按固定的先后存；不认识的值丢掉，一个不剩时回到全选。 */
function statusFilterOf(value: unknown): SidebarStatusFilter[] {
  const picked = new Set(Array.isArray(value) ? value : [])
  const known = SIDEBAR_STATUS_FILTERS.filter((option) => picked.has(option))
  return known.length > 0 ? known : [...SIDEBAR_STATUS_FILTERS]
}

function parseView(raw: string | null): SidebarView {
  if (!raw) return DEFAULT_SIDEBAR_VIEW
  try {
    const value = JSON.parse(raw) as Partial<Record<keyof SidebarView, unknown>>
    return {
      projectOrder: value.projectOrder === "updated" ? "updated" : "manual",
      projectIds: Array.isArray(value.projectIds)
        ? value.projectIds.filter((id): id is string => typeof id === "string")
        : [],
      threadOrder: value.threadOrder === "status" ? "status" : "updated",
      showTime: value.showTime !== false,
      showProject: value.showProject === true,
      statusFilter: statusFilterOf(value.statusFilter),
      archived: value.archived === true,
    }
  } catch {
    return DEFAULT_SIDEBAR_VIEW
  }
}

function readView(): SidebarView {
  let raw: string | null
  try {
    raw = window.localStorage.getItem(VIEW_KEY)
  } catch {
    return viewCache.value
  }
  if (raw !== viewCache.raw) viewCache = { raw, value: parseView(raw) }
  return viewCache.value
}

/** 改侧栏的排序、显示项或筛选，没给的字段保持原样。 */
export function setSidebarView(patch: Partial<SidebarView>): void {
  const next = { ...readView(), ...patch }
  const value = { ...next, statusFilter: statusFilterOf(next.statusFilter) }
  const raw = JSON.stringify(value)
  viewCache = { raw, value }
  try {
    window.localStorage.setItem(VIEW_KEY, raw)
  } catch {
    // 存储不可用时只在本次运行内生效。
  }
  for (const listener of listeners) listener()
}

/** 读取侧栏的排序、显示项和筛选；侧栏菜单和快捷键用同一份。 */
export function useSidebarView(): [SidebarView, (patch: Partial<SidebarView>) => void] {
  const value = useSyncExternalStore(subscribe, readView, () => DEFAULT_SIDEBAR_VIEW)
  return [value, setSidebarView]
}
