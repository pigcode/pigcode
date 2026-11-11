/** PR 标签的数据：进入标签时查询当前分支的 PR，创建后替换状态卡。 */
import { useEffect, useState } from "react"
import type { Connection } from "@pigcode/client-runtime"
import type { PullRequestInfo } from "@pigcode/contracts"
import { toHostError, type HostErrorInfo } from "@pigcode/ui-primitives"
import type { PrCreateInput } from "@pigcode/ui-workbench"
import type { WorkspaceScope } from "./workspace-scope"

/**
 * active 为 true（PR 标签可见）时读取；没有 PR 与 gh 错误都作为面板状态展示。
 * 新会话草稿里看项目根目录的当前分支。
 */
export function usePullRequest(connection: Connection, scope: WorkspaceScope, active: boolean) {
  const [pullRequest, setPullRequest] = useState<PullRequestInfo | null>(null)
  const [loading, setLoading] = useState(false)
  const [creating, setCreating] = useState(false)
  const [error, setError] = useState<HostErrorInfo | null>(null)

  useEffect(() => {
    if (!active) return undefined
    let cancelled = false
    setLoading(true)
    setError(null)
    void (connection.call("pr.status", scope) as Promise<PullRequestInfo | null>)
      .then((info) => {
        if (!cancelled) setPullRequest(info)
      })
      .catch((reason: unknown) => {
        if (cancelled) return
        setPullRequest(null)
        setError(toHostError(reason))
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [active, scope, connection])

  /** 创建 PR；失败时把错误交给面板展示，并继续抛出让表单保持输入。 */
  async function create(input: PrCreateInput): Promise<void> {
    setCreating(true)
    setError(null)
    try {
      setPullRequest(
        (await connection.call("pr.create", { ...scope, ...input })) as PullRequestInfo,
      )
    } catch (reason) {
      setError(toHostError(reason))
      throw reason
    } finally {
      setCreating(false)
    }
  }

  return { pullRequest, loading, creating, error, create }
}
