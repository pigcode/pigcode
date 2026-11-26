/** PR 标签的数据与操作：进入标签时查询当前分支的 PR，支持创建、评论、合并、Ready、关闭与重开。 */
import { useEffect, useState } from "react"
import type { Connection } from "@pigcode/client-runtime"
import type { PullRequestInfo } from "@pigcode/contracts"
import { toHostError, type HostErrorInfo } from "@pigcode/ui-primitives"
import type { PrBusyAction, PrCreateInput, PrMergeInput } from "@pigcode/ui-workbench"
import type { WorkspaceScope } from "./workspace-scope"

/**
 * active 为 true（PR 标签可见）时读取；没有 PR 与 gh 错误都作为面板状态展示。
 * 新会话草稿里看项目根目录的当前分支。
 */
export function usePullRequest(
  connection: Connection,
  scope: WorkspaceScope,
  active: boolean,
  checkoutRevision: number,
  onCheckoutChanged?: () => void,
) {
  const [pullRequest, setPullRequest] = useState<PullRequestInfo | null>(null)
  const [loading, setLoading] = useState(false)
  const [busyAction, setBusyAction] = useState<PrBusyAction | null>(null)
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
  }, [active, scope, connection, checkoutRevision])

  async function runAction<T>(action: PrBusyAction, task: () => Promise<T>): Promise<T> {
    setBusyAction(action)
    setError(null)
    try {
      return await task()
    } catch (reason) {
      setError(toHostError(reason))
      throw reason
    } finally {
      setBusyAction(null)
    }
  }

  /** 创建 PR；失败时把错误交给面板展示，并继续抛出让表单保持输入。 */
  async function create(input: PrCreateInput): Promise<void> {
    await runAction("create", async () => {
      setPullRequest(
        (await connection.call("pr.create", { ...scope, ...input })) as PullRequestInfo,
      )
    })
  }

  /** 发表评论；失败时保留用户输入。 */
  async function comment(body: string): Promise<void> {
    await runAction("comment", async () => {
      await connection.call("pr.comment", { ...scope, body })
    })
  }

  /** 合并 PR；勾选删除源分支时通知外层刷新分支/工作区状态。 */
  async function merge(input: PrMergeInput): Promise<void> {
    await runAction("merge", async () => {
      setPullRequest(
        (await connection.call("pr.merge", { ...scope, ...input })) as PullRequestInfo,
      )
      if (input.deleteBranch) onCheckoutChanged?.()
    })
  }

  /** 将草稿 PR 标记为 Ready。 */
  async function ready(): Promise<void> {
    await runAction("ready", async () => {
      setPullRequest((await connection.call("pr.ready", scope)) as PullRequestInfo)
    })
  }

  /** 关闭 PR。 */
  async function close(): Promise<void> {
    await runAction("close", async () => {
      setPullRequest((await connection.call("pr.close", scope)) as PullRequestInfo)
    })
  }

  /** 重新打开已关闭的 PR。 */
  async function reopen(): Promise<void> {
    await runAction("reopen", async () => {
      setPullRequest((await connection.call("pr.reopen", scope)) as PullRequestInfo)
    })
  }

  return {
    pullRequest,
    loading,
    creating: busyAction === "create",
    busyAction,
    error,
    create,
    comment,
    merge,
    ready,
    close,
    reopen,
  }
}
