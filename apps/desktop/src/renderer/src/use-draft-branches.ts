/** 读当前项目的 Git 分支。项目、窗口焦点或分支菜单变化时重新检查 HEAD。 */
import { useCallback, useEffect, useRef, useState } from "react"
import type { GitBranches } from "@pigcode/contracts"
import type { Connection } from "@pigcode/client-runtime"

export function useDraftBranches(connection: Connection, projectId: string | null) {
  const [branches, setBranches] = useState<GitBranches | null>(null)
  const [error, setError] = useState<string | null>(null)
  const request = useRef(0)
  const lastRead = useRef(0)
  const refresh = useCallback(async () => {
    if (!projectId) return
    const id = ++request.current
    try {
      const next = (await connection.call("git.branches", { projectId })) as GitBranches | null
      if (id !== request.current) return
      lastRead.current = Date.now()
      setBranches(next)
      setError(null)
    } catch (cause) {
      if (id === request.current) setError(cause instanceof Error ? cause.message : String(cause))
    }
  }, [connection, projectId])

  useEffect(() => {
    const reload = () => void refresh()
    reload()
    window.addEventListener("focus", reload)
    // 终端切分支时窗口仍有焦点。只在前台低频检查，打开菜单时仍然立即读取。
    const timer =
      projectId &&
      window.setInterval(() => {
        if (document.hasFocus() && Date.now() - lastRead.current >= 3_000) reload()
      }, 3_000)
    return () => {
      request.current += 1
      window.removeEventListener("focus", reload)
      if (timer) window.clearInterval(timer)
    }
  }, [projectId, refresh])

  function accept(next: GitBranches | null) {
    request.current += 1
    lastRead.current = Date.now()
    setBranches(next)
    setError(null)
  }

  return { branches, error, refresh, accept }
}
