/**
 * ⌘/Ctrl+1…9 打开侧栏里从上往下数的第 n 个会话，输入框里同样生效。顺序和侧栏一样按分组、排序、
 * 筛选与折叠算（sidebar-arrangement.ts），看到第几个就是第几个。
 */
import { useEffect } from "react"
import type { Project, Thread } from "@pigcode/contracts"
import { useSidebarGrouping, useSidebarView } from "@pigcode/ui-primitives"
import { visibleThreads } from "./sidebar-arrangement"
import type { ThreadStatus } from "./thread-status"
import { threadShortcutIndex } from "./window-state"

export function useThreadShortcuts({
  enabled,
  projects,
  threads,
  status,
  expandedProjects,
  heldThreadId,
  onOpen,
}: {
  enabled: boolean
  projects: readonly Project[]
  threads: readonly Thread[]
  status: Readonly<Record<string, ThreadStatus>>
  expandedProjects: Readonly<Record<string, boolean>>
  heldThreadId: string | null
  onOpen: (threadId: string) => void
}): void {
  const [grouping] = useSidebarGrouping()
  const [view] = useSidebarView()
  useEffect(() => {
    if (!enabled) return
    function onKeyDown(event: KeyboardEvent): void {
      const index = threadShortcutIndex(event)
      if (index === null) return
      const target = visibleThreads(projects, threads, {
        grouping,
        view,
        status,
        expandedProjects,
        heldThreadId,
        now: Date.now(),
      })[index - 1]
      if (!target) return
      event.preventDefault()
      onOpen(target.id)
    }
    window.addEventListener("keydown", onKeyDown)
    return () => window.removeEventListener("keydown", onKeyDown)
  }, [enabled, projects, threads, grouping, view, status, expandedProjects, heldThreadId, onOpen])
}
