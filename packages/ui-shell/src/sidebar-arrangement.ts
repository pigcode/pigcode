/**
 * 侧栏怎么摆会话，照 Cursor 的侧栏：按项目、更新时间或状态分组；组里按更新时间或状态排；
 * 按状态筛选，或者只看已归档的。侧栏和 ⌘/Ctrl+数字跳转共用，顺序总是对得上。
 */
import type { Project, Thread, ThreadStatus } from "@pigcode/contracts"
import {
  SIDEBAR_STATUS_FILTERS,
  type SidebarGrouping,
  type SidebarStatusFilter,
  type SidebarView,
} from "@pigcode/ui-primitives"

/** 按更新时间分组时的时间段。 */
export type TimeBucket = "today" | "yesterday" | "week" | "month" | "older"

/** 按状态分组时的段：需要处理里是等你确认或回答的和跑完还没看的，草稿是还没跑过的。 */
export type StatusBucket = "attention" | "error" | "working" | "draft" | "done"

const TIME_BUCKETS: readonly TimeBucket[] = ["today", "yesterday", "week", "month", "older"]
const STATUS_BUCKETS: readonly StatusBucket[] = ["attention", "error", "working", "draft", "done"]

/** 摆会话要用的设置和数据。 */
export interface SidebarArrangement {
  grouping: SidebarGrouping
  view: SidebarView
  /** 各会话的状态；没给的用会话记录上 Host 算的。 */
  status: Readonly<Record<string, ThreadStatus>>
  expandedProjects: Readonly<Record<string, boolean>>
  /** 正在看、刚从「需要处理」里打开的会话；见 useHeldThread。 */
  heldThreadId?: string | null | undefined
  now: number
}

/** 侧栏里的置顶段与各分组。 */
export type SidebarSection =
  | { kind: "pinned"; key: "pinned"; threads: Thread[] }
  | { kind: "project"; key: string; project: Project; open: boolean; threads: Thread[] }
  | { kind: "time"; key: TimeBucket; threads: Thread[] }
  | { kind: "status"; key: StatusBucket; threads: Thread[] }

function startOfDay(time: number): number {
  const date = new Date(time)
  date.setHours(0, 0, 0, 0)
  return date.getTime()
}

/** 按本地日历的天数差分段：当天、前一天、7 天内、30 天内、更早；跨夏令时的那天按四舍五入算整天。 */
export function timeBucket(at: string, now: number): TimeBucket {
  const days = Math.round((startOfDay(now) - startOfDay(Date.parse(at))) / 86_400_000)
  if (days <= 0) return "today"
  if (days === 1) return "yesterday"
  if (days < 7) return "week"
  if (days < 30) return "month"
  return "older"
}

/**
 * 会话的状态类别，也是按状态排序的先后，对应 Cursor 的 needs_attention、error、unread_only、running、
 * draft、done。跑完没看的算未读；held 的会话已经看过，但先当作未读，不从手底下跳走。
 */
export function threadCategory(
  thread: Thread,
  status: ThreadStatus,
  held = false,
): SidebarStatusFilter {
  switch (status) {
    case "waiting-approval":
      return "attention"
    case "failed":
      return "error"
    case "queued":
    case "running":
      return "working"
    case "idle":
      return "draft"
    default:
      return thread.unread || held ? "unread" : "done"
  }
}

function statusBucket(category: SidebarStatusFilter): StatusBucket {
  return category === "unread" ? "attention" : category
}

/** 和 Cursor 一样，「未读」也带上进行中和需要处理的会话：有新东西要看的都算。 */
function passesStatusFilter(
  category: SidebarStatusFilter,
  filter: ReadonlySet<SidebarStatusFilter>,
): boolean {
  if (filter.size === SIDEBAR_STATUS_FILTERS.length) return true
  if (filter.has(category === "unread" ? "done" : category)) return true
  return filter.has("unread") && ["unread", "working", "attention"].includes(category)
}

/** 筛选偏离了默认：只看已归档，或者状态没有全选。偏离时菜单按钮换成强调色，菜单里出现「重置」。 */
export function filtersActive(view: SidebarView): boolean {
  return view.archived || view.statusFilter.length < SIDEBAR_STATUS_FILTERS.length
}

/** 排序和分时间段用的时间；已归档的会话取归档与更新里晚的那个。 */
function activityAt(thread: Thread): string {
  return thread.archivedAt && thread.archivedAt > thread.updatedAt
    ? thread.archivedAt
    : thread.updatedAt
}

/**
 * 项目的先后。手动：排过的按排好的顺序，没排过的（包括新加的）按添加的先后接在后面。
 * 更新时间：按项目里最新的会话，一样新（包括都没有会话）时按手动的先后。
 */
export function orderProjects(
  projects: readonly Project[],
  threads: readonly Thread[],
  view: Pick<SidebarView, "projectOrder" | "projectIds">,
): Project[] {
  const saved = new Map(view.projectIds.map((id, index) => [id, index]))
  const manual = projects
    .map((project, index) => ({ project, rank: saved.get(project.id) ?? saved.size + index }))
    .sort((left, right) => left.rank - right.rank)
    .map(({ project }) => project)
  if (view.projectOrder === "manual") return manual
  const latest = new Map<string, string>()
  for (const thread of threads) {
    const at = activityAt(thread)
    if ((latest.get(thread.projectId) ?? "") < at) latest.set(thread.projectId, at)
  }
  return manual.sort((left, right) =>
    (latest.get(right.id) ?? "").localeCompare(latest.get(left.id) ?? ""),
  )
}

/** 把 id 挪到 target 的前面或后面，返回新的顺序。 */
export function moveProject(
  order: readonly string[],
  id: string,
  target: string,
  place: "before" | "after",
): string[] {
  const rest = order.filter((item) => item !== id)
  const index = rest.indexOf(target)
  if (id === target || index === -1) return [...order]
  rest.splice(place === "after" ? index + 1 : index, 0, id)
  return rest
}

/** 按 keys 的先后把会话分段，空的段不要。 */
function groupInto<K extends string>(
  threads: readonly Thread[],
  keys: readonly K[],
  keyOf: (thread: Thread) => K,
): Array<{ key: K; threads: Thread[] }> {
  const byKey = new Map<K, Thread[]>()
  for (const thread of threads) {
    const key = keyOf(thread)
    const list = byKey.get(key)
    if (list) list.push(thread)
    else byKey.set(key, [thread])
  }
  return keys.flatMap((key) => {
    const list = byKey.get(key)
    return list ? [{ key, threads: list }] : []
  })
}

/** 侧栏看的会话：没归档的（只看已归档时反过来），项目不在了的不算。状态筛选之前的范围。 */
function poolOf(
  projects: readonly Project[],
  threads: readonly Thread[],
  view: SidebarView,
): Thread[] {
  const known = new Set(projects.map((project) => project.id))
  return threads.filter(
    (thread) => (thread.archivedAt !== null) === view.archived && known.has(thread.projectId),
  )
}

/** 所有项目从上到下的先后（包括筛选时藏起来的）；拖动和上移下移在这个顺序上改。 */
export function projectOrder(
  projects: readonly Project[],
  threads: readonly Thread[],
  view: SidebarView,
): string[] {
  return orderProjects(projects, poolOf(projects, threads, view), view).map((project) => project.id)
}

/**
 * 侧栏从上到下的各段。项目按更新时间排时看的是筛选之前的会话，切换状态筛选时项目不跟着跳；
 * 按项目分组且没在筛选时，没有会话的项目也列出来。
 */
export function sidebarSections(
  projects: readonly Project[],
  threads: readonly Thread[],
  arrangement: SidebarArrangement,
): SidebarSection[] {
  const { grouping, view } = arrangement
  const filter = new Set(view.statusFilter)
  const category = new Map<string, SidebarStatusFilter>()
  const pool = poolOf(projects, threads, view)
  const shown = pool.filter((thread) => {
    const status = arrangement.status[thread.id] ?? thread.status ?? "idle"
    const value = threadCategory(thread, status, thread.id === arrangement.heldThreadId)
    category.set(thread.id, value)
    return passesStatusFilter(value, filter)
  })
  const rank = (thread: Thread) => SIDEBAR_STATUS_FILTERS.indexOf(category.get(thread.id)!)
  shown.sort(
    (left, right) =>
      (view.threadOrder === "status" ? rank(left) - rank(right) : 0) ||
      activityAt(right).localeCompare(activityAt(left)) ||
      left.id.localeCompare(right.id),
  )
  const pinnedThreads = view.archived ? [] : shown.filter((thread) => thread.pinned)
  const remaining = pinnedThreads.length > 0 ? shown.filter((thread) => !thread.pinned) : shown
  const pinned: SidebarSection[] = pinnedThreads.length > 0
    ? [{ kind: "pinned", key: "pinned", threads: pinnedThreads }]
    : []
  if (grouping === "time") {
    const groups = groupInto(remaining, TIME_BUCKETS, (thread) =>
      timeBucket(activityAt(thread), arrangement.now),
    )
    return [...pinned, ...groups.map((section) => ({ kind: "time" as const, ...section }))]
  }
  if (grouping === "status") {
    const groups = groupInto(remaining, STATUS_BUCKETS, (thread) =>
      statusBucket(category.get(thread.id)!),
    )
    return [...pinned, ...groups.map((section) => ({ kind: "status" as const, ...section }))]
  }
  const filtering = filtersActive(view)
  const matchingProjects = new Set(shown.map((thread) => thread.projectId))
  const groups = orderProjects(projects, pool, view).flatMap((project): SidebarSection[] => {
    if (filtering && !matchingProjects.has(project.id)) return []
    const projectThreads = remaining.filter((thread) => thread.projectId === project.id)
    const open = arrangement.expandedProjects[project.id] ?? true
    return [{ kind: "project", key: project.id, project, open, threads: projectThreads }]
  })
  return [...pinned, ...groups]
}

/** 侧栏里从上到下看得见的会话；⌘/Ctrl+数字按这个顺序跳转。 */
export function visibleThreads(
  projects: readonly Project[],
  threads: readonly Thread[],
  arrangement: SidebarArrangement,
): Thread[] {
  return visibleThreadsInSections(sidebarSections(projects, threads, arrangement))
}

export function visibleThreadsInSections(sections: readonly SidebarSection[]): Thread[] {
  return sections.flatMap((section) =>
    section.kind === "project" && !section.open ? [] : section.threads,
  )
}
