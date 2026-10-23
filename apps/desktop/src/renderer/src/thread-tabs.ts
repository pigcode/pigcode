/**
 * 线程头标签的选择状态：每个主会话选中的标签、用户关掉的派生子代理、从时间线手动打开的派生子代理。
 * 状态在窗口生命周期内保留，切到设置页再回来时标签选择不丢。
 */
import { useSyncExternalStore } from "react"
import type { Thread } from "@pigcode/contracts"
import type { SubagentCall, ThreadTab } from "@pigcode/ui-chat"
import type { ThreadViewStatus } from "@pigcode/client-runtime"

/** 一个主会话的标签状态。 */
export interface ThreadTabState {
  selected: string
  dismissed: ReadonlySet<string>
  opened: ReadonlySet<string>
}

const EMPTY: ThreadTabState = { selected: "main", dismissed: new Set(), opened: new Set() }
const states = new Map<string, ThreadTabState>()
const listeners = new Set<() => void>()
let version = 0

function write(threadId: string, next: ThreadTabState): void {
  states.set(threadId, next)
  version += 1
  for (const listener of listeners) listener()
}

function read(threadId: string): ThreadTabState {
  return states.get(threadId) ?? EMPTY
}

/** 读取某个主会话的标签状态（非 React 场景）。 */
export function threadTabState(threadId: string): ThreadTabState {
  return read(threadId)
}

/** 选中标签。 */
export function selectThreadTab(threadId: string, tabId: string): void {
  write(threadId, { ...read(threadId), selected: tabId })
}

/** 在标签页中打开一个派生子代理（从时间线卡片），即使它之前被关掉过。 */
export function openSpawnedTab(threadId: string, subagentId: string): void {
  const state = read(threadId)
  const dismissed = new Set(state.dismissed)
  dismissed.delete(subagentId)
  write(threadId, {
    selected: `spawned:${subagentId}`,
    dismissed,
    opened: new Set([...state.opened, subagentId]),
  })
}

/** 关掉派生子代理的标签；正在看它时回到主会话。 */
export function dismissSpawnedTab(threadId: string, subagentId: string): void {
  const state = read(threadId)
  const opened = new Set(state.opened)
  opened.delete(subagentId)
  write(threadId, {
    selected: state.selected === `spawned:${subagentId}` ? "main" : state.selected,
    dismissed: new Set([...state.dismissed, subagentId]),
    opened,
  })
}

/** 测试用：清空所有标签状态。 */
export function resetThreadTabs(): void {
  states.clear()
  write("", EMPTY)
}

/** 订阅某个主会话的标签状态。 */
export function useThreadTabState(threadId: string | null): ThreadTabState {
  useSyncExternalStore(
    (listener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    () => version,
  )
  return threadId ? read(threadId) : EMPTY
}

/** 运行中、排队或等待许可都算子代理在忙。 */
export function isBusy(status: ThreadViewStatus | undefined): boolean {
  return status === "running" || status === "queued" || status === "waiting-approval"
}

/**
 * 派生子代理里该显示成标签的：最近一次派生过子代理的 run 里的全部，加上从时间线手动打开的；
 * 用户关掉的不再显示。
 */
export function visibleSpawned(
  subagents: ReadonlyMap<string, SubagentCall>,
  state: ThreadTabState,
): SubagentCall[] {
  const all = [...subagents.values()]
  const latestRun = all.at(-1)?.runId ?? null
  return all.filter(
    (subagent) =>
      !state.dismissed.has(subagent.id) &&
      ((latestRun !== null && subagent.runId === latestRun) || state.opened.has(subagent.id)),
  )
}

/** 组装标签栏：主会话、用户添加的子代理（按创建顺序）、派生子代理。 */
export function buildThreadTabs(input: {
  main: Thread
  projectName: string | undefined
  children: readonly Thread[]
  statuses: Readonly<Record<string, ThreadViewStatus | undefined>>
  spawned: readonly SubagentCall[]
}): ThreadTab[] {
  const { main, projectName, children, statuses, spawned } = input
  return [
    {
      id: "main",
      kind: "main",
      title: main.title,
      description: projectName ? `${projectName} / ${main.title}` : main.title,
    },
    ...children.map((child): ThreadTab => ({
      id: `agent:${child.id}`,
      kind: "agent",
      title: child.title,
      agentId: child.lastProviderId ?? child.defaultProviderId,
      running: isBusy(statuses[child.id]),
      waiting: statuses[child.id] === "waiting-approval",
      closable: true,
    })),
    ...spawned.map((subagent): ThreadTab => ({
      id: `spawned:${subagent.id}`,
      kind: "spawned",
      title: subagent.description ?? subagent.name,
      description: subagent.description
        ? `${subagent.name} · ${subagent.description}`
        : subagent.name,
      running: subagent.status === "running",
      closable: true,
    })),
  ]
}

/** 主会话下未归档的子代理，按创建时间排列。 */
export function childThreads(threads: readonly Thread[], mainId: string | null): Thread[] {
  if (!mainId) return []
  return threads
    .filter((thread) => thread.parentThreadId === mainId && thread.archivedAt === null)
    .sort((left, right) => left.createdAt.localeCompare(right.createdAt))
}
