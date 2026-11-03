/**
 * 右侧面板（Workbench）容器：标签状态由 App 按线程保存，可以打开的 Surface 来自扩展点注册表。
 * 内置 Surface 的数据（文件、Diff、PR、检查点、worktree）在这里接到 Host RPC，经 WorkbenchContext
 * 交给它们登记的 render；插件的 Surface 用同样的标签栏与外框。
 */
import { Fragment, useCallback, useEffect, useMemo, useState, type ReactNode } from "react"
import { contributionText, useContributions, type Connection } from "@pigcode/client-runtime"
import { useLocale } from "@pigcode/ui-primitives"
import {
  FILE_SURFACE_KIND,
  RightPanel,
  addSurface,
  closeSurface,
  openFileSurface,
  type PanelSurface,
  type PanelSurfaceState,
} from "@pigcode/ui-workbench"
import { DiscardDraftDialog } from "./discard-draft-dialog"
import { getDraft, setDraft, useDraftVersion } from "./file-drafts"
import { FileSurface } from "./files-surface"
import { usePullRequest } from "./use-pull-request"
import { useWorktrees } from "./use-worktrees"
import {
  WorkbenchContext,
  type CheckpointRecord,
  type WorkbenchContextValue,
} from "./workbench-context"

/** 右侧面板属性；标签状态由 App 按线程保存，线程切换时父组件用 key 重新挂载以释放终端。 */
export interface WorkbenchPanelProps {
  connection: Connection
  threadId: string
  panel: PanelSurfaceState
  onPanelChange: (update: (state: PanelSurfaceState) => PanelSurfaceState) => void
  /** 标签栏右侧的布局按钮。 */
  controls?: ReactNode
  onError: (message: string) => void
  /** 项目名：文件树与面包屑的根。 */
  projectName: string
  /** agent 改过文件（工具调用结束、run 结束）时递增，文件树与打开的文件据此重读。 */
  workspaceRevision: number
}

let surfaceSeq = 0

/** 生成 surface id；只需在本窗口内唯一。 */
function nextSurfaceId(): string {
  surfaceSeq += 1
  return `surface-${surfaceSeq}`
}

/** 把 unknown 错误转成可展示文本。 */
function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** 带结果类型的 RPC 调用；方法名与参数由 contracts 校验。 */
async function callRpc<T>(connection: Connection, method: string, params: unknown): Promise<T> {
  return (await connection.call(method, params)) as T
}

/** 右侧面板；文件、Diff、PR 的数据只在对应标签激活时加载，终端与浏览器标签切走后保持挂载。 */
export function WorkbenchPanel({
  connection,
  threadId,
  panel,
  onPanelChange,
  controls,
  onError,
  projectName,
  workspaceRevision,
}: WorkbenchPanelProps) {
  const { t } = useLocale()
  const surfaceContributions = useContributions("surface")
  const tab: string | null =
    panel.surfaces.find((surface) => surface.id === panel.activeId)?.kind ?? null
  // 保存文件、恢复检查点、切换 worktree 都会改动工作目录，与 agent 改文件一样要让文件树、
  // git 标记与打开的文件重读。
  const [localRevision, setLocalRevision] = useState(0)
  const revision = workspaceRevision + localRevision
  const [pendingClose, setPendingClose] = useState<PanelSurface | null>(null)
  const draftVersion = useDraftVersion()
  const [checkpoints, setCheckpoints] = useState<CheckpointRecord[]>([])
  const [checkpointError, setCheckpointError] = useState<string | null>(null)
  const [checkpointBusy, setCheckpointBusy] = useState(false)
  const [diff, setDiff] = useState("")
  const [diffLoading, setDiffLoading] = useState(false)
  const [diffError, setDiffError] = useState<string | null>(null)
  const [diffBase, setDiffBase] = useState<string | null>(null)
  // 切换或新建 worktree 会换掉线程的工作目录，同样要重读文件树与打开的文件。
  const worktrees = useWorktrees(connection, threadId, onError, () =>
    setLocalRevision((count) => count + 1),
  )
  const pr = usePullRequest(connection, threadId, tab === "pr")

  /** 重新拉取 checkpoint 列表；Diff 与 Checkpoint tab 共用。 */
  const refreshCheckpoints = useCallback(async (): Promise<void> => {
    const list = await callRpc<CheckpointRecord[]>(connection, "checkpoint.list", { threadId })
    setCheckpoints(list)
  }, [connection, threadId])

  useEffect(() => {
    setCheckpointError(null)
    void refreshCheckpoints().catch((error: unknown) => setCheckpointError(messageOf(error)))
  }, [refreshCheckpoints])

  /** checkpoint 提交落盘的 commit；Diff 的基准与目标只从这里取。 */
  const committed = useMemo(
    () => checkpoints.filter((checkpoint) => checkpoint.commitSha !== null),
    [checkpoints],
  )
  const defaultBase = useMemo(() => {
    const baselines = committed.filter((checkpoint) => checkpoint.phase === "baseline")
    return baselines[baselines.length - 1]?.commitSha ?? null
  }, [committed])
  // 还没有结束快照时（没跑过、或者正在跑）和当前工作区比较：没跑过时是未提交的改动，
  // 正在跑时是这一轮到目前为止的改动。
  const headSha = useMemo(() => {
    const finals = committed.filter((checkpoint) => checkpoint.phase !== "baseline")
    const latestBaseline = committed.filter((checkpoint) => checkpoint.phase === "baseline").at(-1)
    const latestFinal = finals.at(-1)
    if (!latestFinal || (latestBaseline && latestBaseline.createdAt > latestFinal.createdAt)) {
      return "WORKTREE"
    }
    return latestFinal.commitSha ?? "WORKTREE"
  }, [committed])
  const baseSha = diffBase ?? defaultBase

  // Diff：选中 checkpoint 作基准，未选中时用最近 run 的 baseline/final。
  useEffect(() => {
    if (tab !== "diff") return undefined
    let cancelled = false
    setDiffLoading(true)
    setDiffError(null)
    void callRpc<string>(connection, "git.diff", {
      threadId,
      base: baseSha ?? "HEAD",
      head: headSha,
    })
      .then((text) => {
        if (!cancelled) setDiff(text)
      })
      .catch((error: unknown) => {
        if (!cancelled) {
          setDiff("")
          setDiffError(messageOf(error))
        }
      })
      .finally(() => {
        if (!cancelled) setDiffLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [tab, threadId, connection, baseSha, headSha])

  async function createCheckpoint(): Promise<void> {
    setCheckpointBusy(true)
    setCheckpointError(null)
    try {
      await connection.call("checkpoint.create", { threadId })
      await refreshCheckpoints()
    } catch (error) {
      onError(messageOf(error))
    } finally {
      setCheckpointBusy(false)
    }
  }

  async function restoreCheckpoint(checkpointId: string): Promise<void> {
    setCheckpointBusy(true)
    setCheckpointError(null)
    try {
      await connection.call("checkpoint.restore", { threadId, checkpointId })
      setLocalRevision((count) => count + 1)
      await refreshCheckpoints()
    } catch (error) {
      onError(messageOf(error))
    } finally {
      setCheckpointBusy(false)
    }
  }

  function add(kind: string): void {
    const surface = surfaceContributions.find((item) => item.id === kind)
    if (!surface) return
    const name = contributionText(t, surface.title)
    onPanelChange((state) =>
      addSurface(state, kind, nextSurfaceId(), (index) => surface.tabTitle?.(name, index) ?? name, {
        multiInstance: surface.multiInstance,
      }),
    )
  }

  /** 关闭标签；有未保存修改的文件标签先确认。 */
  function close(id: string): void {
    const surface = panel.surfaces.find((item) => item.id === id)
    if (surface?.kind === "file" && surface.path && getDraft(threadId, surface.path) !== null) {
      setPendingClose(surface)
      return
    }
    onPanelChange((state) => closeSurface(state, id))
  }

  /** 打开文件标签；从文件树标签打开时文件树收进文件标签的侧栏，原标签被替换。 */
  function openFile(path: string, replace?: string): void {
    onPanelChange((state) => openFileSurface(state, path, nextSurfaceId(), { replace }))
  }

  // 文件标签的标题后面带一个圆点表示未保存。
  const surfaces = useMemo(
    () =>
      panel.surfaces.map((surface) =>
        surface.kind === "file" && surface.path
          ? { ...surface, dirty: getDraft(threadId, surface.path) !== null }
          : surface,
      ),
    // draftVersion 变化时重新读取草稿。
    [panel.surfaces, threadId, draftVersion],
  )

  const fileProps = {
    connection,
    threadId,
    rootName: projectName,
    revision,
    onError,
    onSaved: () => setLocalRevision((count) => count + 1),
  }

  const context: WorkbenchContextValue = {
    connection,
    threadId,
    add,
    close,
    openFile,
    fileProps,
    worktrees,
    diff: {
      committed,
      baseSha,
      setBase: setDiffBase,
      text: diff,
      loading: diffLoading,
      error: diffError,
    },
    checkpoints: {
      list: checkpoints,
      error: checkpointError,
      busy: checkpointBusy,
      create: createCheckpoint,
      restore: restoreCheckpoint,
    },
    pr,
  }

  return (
    <WorkbenchContext.Provider value={context}>
      <div className="workbench">
        <RightPanel
          threadId={threadId}
          surfaces={surfaces}
          activeId={panel.activeId}
          onActivate={(id) => onPanelChange((state) => ({ ...state, activeId: id }))}
          onClose={close}
          onAdd={add}
          controls={controls}
        >
          {panel.surfaces.map((surface) => {
            const active = surface.id === panel.activeId
            if (surface.kind === FILE_SURFACE_KIND) {
              return active ? (
                <div key={surface.id} className="surface-pane">
                  <FileSurface
                    {...fileProps}
                    path={surface.path ?? ""}
                    line={surface.line}
                    onOpenFile={(path) => openFile(path)}
                  />
                </div>
              ) : null
            }
            // 已经注销的 Surface（插件刚停用）不渲染；App 随即关掉它的标签。
            const contribution = surfaceContributions.find((item) => item.id === surface.kind)
            if (!contribution || (!active && !contribution.keepMounted)) return null
            return (
              <Fragment key={surface.id}>{contribution.render({ tab: surface, active })}</Fragment>
            )
          })}
        </RightPanel>
        <DiscardDraftDialog
          file={pendingClose?.title ?? null}
          onCancel={() => setPendingClose(null)}
          onDiscard={() => {
            const surface = pendingClose
            setPendingClose(null)
            if (!surface) return
            if (surface.path) setDraft(threadId, surface.path, null)
            onPanelChange((state) => closeSurface(state, surface.id))
          }}
        />
      </div>
    </WorkbenchContext.Provider>
  )
}
