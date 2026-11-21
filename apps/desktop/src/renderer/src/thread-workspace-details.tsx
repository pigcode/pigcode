/**
 * 会话详情卡上面两段（照 T3 Code 的 ThreadDetailsPanel）：工作区是会话用的文件夹（在 worktree 里时标出来）
 * 和用哪个应用打开；版本控制是当前分支和还有几个文件没提交，点「改动」在右侧面板打开 Diff。
 * 新会话草稿还没有会话，看的是草稿的项目。卡片打开时才挂上，这时才去读 git 状态。
 */
import { useEffect, useState } from "react"
import { FileDiff, Folder, FolderGit2, GitBranch } from "lucide-react"
import type { Connection } from "@pigcode/client-runtime"
import { useLocale } from "@pigcode/ui-primitives"
import { OpenInRow } from "@pigcode/ui-shell"

/** git.status 的结果；detached HEAD 时 branch 为 null。 */
interface GitStatus {
  branch: string | null
  changed: Array<{ path: string; status: string }>
}

/**
 * 会话工作目录（草稿时是项目文件夹）的 git 状态；revision 变了（agent 改了文件、跑完一轮、切了分支或
 * worktree）就重读，读到之前接着显示上一次的。还没读到是 undefined，不是 git 仓库是 null。
 */
function useGitStatus(
  connection: Connection,
  threadId: string | undefined,
  projectId: string | undefined,
  revision: number,
): GitStatus | null | undefined {
  const key = threadId ?? projectId
  const [state, setState] = useState<{ key: string; status: GitStatus | null } | null>(null)
  useEffect(() => {
    if (key === undefined) return
    let cancelled = false
    const scope = threadId !== undefined ? { threadId } : { projectId }
    void (connection.call("git.status", scope) as Promise<GitStatus>)
      .then((status) => {
        if (!cancelled) setState({ key, status })
      })
      .catch(() => {
        if (!cancelled) setState({ key, status: null })
      })
    return () => {
      cancelled = true
    }
  }, [connection, key, threadId, projectId, revision])
  return state !== null && state.key === key ? state.status : undefined
}

/** 去掉末尾的分隔符再比较，Host 给的两个路径写法一致。 */
function samePath(left: string, right: string): boolean {
  return left.replace(/[\\/]+$/, "") === right.replace(/[\\/]+$/, "")
}

export function ThreadWorkspaceDetails({
  connection,
  threadId,
  projectId,
  root,
  projectRoot,
  revision,
  onOpenDiff,
}: {
  connection: Connection
  /** 看哪个会话的工作目录；新会话草稿没有会话，传 projectId。两个只给一个。 */
  threadId?: string | undefined
  projectId?: string | undefined
  /** 会话的工作目录：项目文件夹，或者它的一个 worktree；草稿时是项目文件夹。 */
  root: string
  projectRoot: string | undefined
  revision: number
  onOpenDiff?: (() => void) | undefined
}) {
  const { t } = useLocale()
  const git = useGitStatus(connection, threadId, projectId, revision)
  const name = root.split(/[\\/]/).filter(Boolean).at(-1) ?? root
  const worktree = projectRoot !== undefined && !samePath(root, projectRoot)
  const FolderIcon = worktree ? FolderGit2 : Folder
  const changed = git?.changed.length ?? 0
  return (
    <>
      <section className="details-section" aria-label={t("details.workspace")}>
        <div className="details-row" title={root}>
          <FolderIcon className="ic" aria-hidden="true" />
          <span className="details-row-label">{name}</span>
          {worktree ? <span className="details-row-meta">{t("worktree.label")}</span> : null}
        </div>
        <OpenInRow path={root} />
      </section>
      {git ? (
        <section className="details-section" aria-label={t("details.versionControl")}>
          <div className="details-row" title={git.branch ?? undefined}>
            <GitBranch className="ic" aria-hidden="true" />
            <span className="details-row-label">
              {git.branch ?? t("newThread.branch.detached")}
            </span>
          </div>
          {onOpenDiff ? (
            <button
              type="button"
              className="details-row"
              title={t("details.changes.review")}
              onClick={onOpenDiff}
            >
              <FileDiff className="ic" aria-hidden="true" />
              <span className="details-row-label">{t("details.changes")}</span>
              <span className="details-row-meta">
                {changed === 0
                  ? t("details.changes.clean")
                  : t(
                      changed === 1
                        ? "details.changes.uncommitted.one"
                        : "details.changes.uncommitted.other",
                    ).replace("{count}", String(changed))}
              </span>
            </button>
          ) : null}
        </section>
      ) : null}
    </>
  )
}
