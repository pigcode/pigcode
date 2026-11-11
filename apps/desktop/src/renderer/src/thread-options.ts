/**
 * 输入框 @ 菜单里可以引用的会话（#81）：除了当前会话以外的全部会话，最近活动的在前。
 * 不搜索时菜单只列当前项目、没归档的；搜索时也找其他项目和已归档的（由输入框决定）。
 */
import { useMemo } from "react"
import type { Project, Thread } from "@pigcode/contracts"
import type { ComposerThreadOption } from "@pigcode/ui-composer"

export function threadOptions(
  threads: readonly Thread[],
  projects: readonly Project[],
  currentThreadId: string | null,
  currentProjectId: string | null,
): ComposerThreadOption[] {
  const names = new Map(projects.map((project) => [project.id, project.name]))
  return [...threads]
    .filter((thread) => thread.id !== currentThreadId)
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
    .map((thread) => ({
      id: thread.id,
      title: thread.title,
      projectName: names.get(thread.projectId),
      sameProject: thread.projectId === currentProjectId,
      archived: thread.archivedAt !== null,
    }))
}

export function useThreadOptions(
  threads: readonly Thread[],
  projects: readonly Project[],
  currentThreadId: string | null,
  currentProjectId: string | null,
): ComposerThreadOption[] {
  return useMemo(
    () => threadOptions(threads, projects, currentThreadId, currentProjectId),
    [threads, projects, currentThreadId, currentProjectId],
  )
}
