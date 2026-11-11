/**
 * 线程的 git worktree：列表与当前选择来自 Host，创建、切换、移除后通知调用方工作目录变了。
 * worktree 属于会话；新会话草稿里（threadId 为 null）没有 worktree，也不能创建。
 */
import { useEffect, useState } from "react"
import type { Connection } from "@pigcode/client-runtime"

/** worktree.list/create/switch 返回的记录。 */
export interface WorktreeRecord {
  id: string
  path: string
  branch: string | null
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * worktree 状态与操作。onChanged 在线程的工作目录变了以后调用（文件树、打开的文件要重读）；
 * 失败交给 onError。
 */
export function useWorktrees(
  connection: Connection,
  threadId: string | null,
  onError: (message: string) => void,
  onChanged: () => void,
) {
  const [worktrees, setWorktrees] = useState<WorktreeRecord[]>([])
  const [activePath, setActivePath] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  // 重开应用后从 Host 恢复列表与当前选择。
  useEffect(() => {
    if (!threadId) {
      setWorktrees([])
      setActivePath(null)
      return undefined
    }
    let cancelled = false
    void (
      connection.call("worktree.list", { threadId }) as Promise<{
        worktrees: WorktreeRecord[]
        activePath: string | null
      }>
    )
      .then((result) => {
        if (cancelled) return
        setWorktrees(result.worktrees)
        setActivePath(result.activePath)
      })
      .catch(() => undefined)
    return () => {
      cancelled = true
    }
  }, [connection, threadId])

  async function run(action: (threadId: string) => Promise<void>): Promise<void> {
    if (!threadId) return
    setBusy(true)
    try {
      await action(threadId)
      onChanged()
    } catch (error) {
      onError(messageOf(error))
    } finally {
      setBusy(false)
    }
  }

  return {
    /** 草稿里没有 worktree 可选，界面隐藏选择器。 */
    available: threadId !== null,
    worktrees,
    activePath,
    busy,
    create: () =>
      run(async (threadId) => {
        const worktree = (await connection.call("worktree.create", { threadId })) as WorktreeRecord
        setWorktrees((current) => [
          ...current.filter((item) => item.path !== worktree.path),
          worktree,
        ])
        setActivePath(worktree.path)
      }),
    switchTo: (path: string) =>
      run(async (threadId) => {
        const worktree = (await connection.call("worktree.switch", {
          threadId,
          path,
        })) as WorktreeRecord
        setActivePath(worktree.path)
      }),
    remove: () =>
      run(async (threadId) => {
        await connection.call("worktree.remove", { threadId })
        setWorktrees((current) => current.filter((item) => item.path !== activePath))
        setActivePath(null)
      }),
  }
}
