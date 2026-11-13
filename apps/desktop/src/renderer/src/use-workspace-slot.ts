/**
 * 右侧面板与底部终端挂在谁身上、按哪个 key 保存（参照 ZCode，它们不必依附会话）。
 * 会话里挂在会话上，key 是会话 id；新会话草稿里挂在草稿的项目上，key 是「第几个草稿 + 项目」。
 * 在项目原目录建成的会话接过草稿的 key。独立 worktree 会话使用自己的 key，原目录的文件草稿仍归草稿。
 */
import { useCallback, useEffect, useRef } from "react"
import { onDraftMaterialized } from "./new-thread-draft"
import type { WorkspaceScope } from "./workspace-scope"

const DRAFT_PREFIX = "draft:"

/** 当前位置的归属与 key，以及会话 id 与 key 之间的换算。 */
export interface WorkspaceSlot {
  /** 既不在会话里也不在有项目的草稿里时为 null。 */
  scope: WorkspaceScope | null
  key: string | null
  /** 会话的面板 key：由草稿建成的会话沿用草稿的 key。 */
  keyOf(threadId: string): string
  /** 当前草稿序号下指定项目的面板 key。 */
  draftKeyOf(projectId: string): string
  /** key 属于哪个会话；还是草稿时为 null。 */
  threadOf(key: string): string | null
}

export function useWorkspaceSlot(
  threadId: string | null,
  draftProjectId: string | null,
): WorkspaceSlot {
  // 都用 ref：建会话的通知与当前会话的切换在同一个同步过程里，下一次渲染时必须已经记下。
  const draftSlot = useRef(1)
  const adopted = useRef(new Map<string, string>())
  const current = useRef<string | null>(null)
  // 草稿交出去以后要换新的序号，但要等新会话真正成为当前会话：通知与切换之间如果先渲染了一次
  // （别的监听器同步提交了状态），那时还在草稿里，必须仍然拿到原来的 key，否则面板会被重新挂载。
  const retiring = useRef(false)

  useEffect(
    () =>
      onDraftMaterialized((thread, isolated) => {
        if (isolated) return
        const key = current.current
        if (!key?.startsWith(DRAFT_PREFIX)) return
        adopted.current.set(thread.id, key)
        retiring.current = true
      }),
    [],
  )
  if (threadId && retiring.current) {
    retiring.current = false
    draftSlot.current += 1
  }

  const keyOf = useCallback((id: string) => adopted.current.get(id) ?? id, [])
  const draftKeyOf = (projectId: string) => `${DRAFT_PREFIX}${draftSlot.current}:${projectId}`
  const threadOf = useCallback((key: string) => {
    if (!key.startsWith(DRAFT_PREFIX)) return key
    for (const [id, adoptedKey] of adopted.current) if (adoptedKey === key) return id
    return null
  }, [])

  const key = threadId ? keyOf(threadId) : draftProjectId ? draftKeyOf(draftProjectId) : null
  current.current = key
  const scope: WorkspaceScope | null = threadId
    ? { threadId }
    : draftProjectId
      ? { projectId: draftProjectId }
      : null
  return { scope, key, keyOf, draftKeyOf, threadOf }
}
