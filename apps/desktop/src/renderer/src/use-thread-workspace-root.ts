import { useEffect, useState } from "react"
import type { Connection } from "@pigcode/client-runtime"

/** 顶栏「打开」与聊天里的绝对路径使用与文件、终端相同的工作目录。 */
export function useThreadWorkspaceRoot(
  connection: Connection,
  threadId: string | null,
  connected: boolean,
  checkoutRevision: number,
): string | undefined {
  const [workspace, setWorkspace] = useState<{ threadId: string; root: string } | null>(null)
  useEffect(() => {
    if (!threadId || !connected) return
    let cancelled = false
    void (connection.call("workspace.root", { threadId }) as Promise<{ root: string }>)
      .then(({ root }) => {
        if (!cancelled) setWorkspace({ threadId, root })
      })
      .catch(() => undefined)
    return () => {
      cancelled = true
    }
  }, [connection, threadId, connected, checkoutRevision])
  return workspace?.threadId === threadId ? workspace?.root : undefined
}
