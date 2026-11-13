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
  updateSurface,
  type PanelSurface,
  type PanelSurfaceState,
} from "@pigcode/ui-workbench"
import { DiscardDraftDialog } from "./discard-draft-dialog"
import { getDraft, setDraft, useDraftVersion } from "./file-drafts"
import { usePullRequest } from "./use-pull-request"
import { useWorktrees } from "./use-worktrees"
import { scopeThreadId, type WorkspaceScope } from "./workspace-scope"
import {
  WorkbenchContext,
  type CheckpointRecord,
  type WorkbenchContextValue,
} from "./workbench-context"

/**
 * 右侧面板属性；标签状态由 App 按 slotKey 保存，切换会话时父组件用 key 重新挂载以释放终端。
 * 新会话草稿里也能打开（参照 ZCode）：scope 是草稿的项目，文件、Diff、PR 看项目根目录；
 * 草稿建成会话后 slotKey 不变，面板不重新挂载，scope 换成会话。
 */
export interface WorkbenchPanelProps {
  connection: Connection
  scope: WorkspaceScope
  /** 面板在 App 里的 key；文件的未保存修改按它记，草稿变成会话后不变。 */
  slotKey: string
  panel: PanelSurfaceState
  onPanelChange: (update: (state: PanelSurfaceState) => PanelSurfaceState) => void
  /** 标签栏右侧的布局按钮。 */
  controls?: ReactNode
  onError: (message: string) => void
  /** 项目名：文件树与面包屑的根。 */
  projectName: string
  /** agent 改过文件（工具调用结束、run 结束）时递增，文件树与打开的文件据此重读。 */
  workspaceRevision: number
  checkoutRevision: number
  onCheckoutChanged: () => void
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
  scope: scopeProp,
  slotKey,
  panel,
  onPanelChange,
  controls,
  onError,
  projectName,
  workspaceRevision,
  checkoutRevision,
  onCheckoutChanged,
}: WorkbenchPanelProps) {
  const { t } = useLocale()
  const surfaceContributions = useContributions("surface")
  // App 每次渲染都给一个新对象；按 id 固定下来，依赖它的读取才不会每次重跑。
  const threadId = scopeThreadId(scopeProp)
  const projectId = "projectId" in scopeProp ? scopeProp.projectId : null
  const scope = useMemo<WorkspaceScope>(
    () => (threadId ? { threadId } : { projectId: projectId ?? "" }),
    [threadId, projectId],
  )
  const activeSurface = panel.surfaces.find((surface) => surface.id === panel.activeId)
  const tab = activeSurface?.kind ?? null
  // 保存文件、恢复检查点、切换 worktree 都会改动工作目录，与 agent 改文件一样要让文件树、
  // git 标记与打开的文件重读。
  const [localRevision, setLocalRevision] = useState(0)
  const revision = workspaceRevision + localRevision + checkoutRevision
  const [pendingClose, setPendingClose] = useState<PanelSurface[] | null>(null)
  const draftVersion = useDraftVersion()
  const [checkpoints, setCheckpoints] = useState<CheckpointRecord[]>([])
  const [checkpointError, setCheckpointError] = useState<string | null>(null)
  const [checkpointBusy, setCheckpointBusy] = useState(false)
  const [diff, setDiff] = useState("")
  const [diffLoading, setDiffLoading] = useState(false)
  const [diffError, setDiffError] = useState<string | null>(null)
  const [diffBase, setDiffBase] = useState<string | null>(null)
  // 切换或新建 worktree 会换掉线程的工作目录，同样要重读文件树与打开的文件。
  const worktrees = useWorktrees(connection, threadId, onError, onCheckoutChanged)
  const pr = usePullRequest(connection, scope, tab === "pr", checkoutRevision)

  /** 重新拉取 checkpoint 列表；Diff 与 Checkpoint tab 共用。检查点属于会话的 run，草稿里没有。 */
  const refreshCheckpoints = useCallback(async (): Promise<void> => {
    if (!threadId) {
      setCheckpoints([])
      return
    }
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
      ...scope,
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
  }, [tab, scope, connection, baseSha, headSha])

  async function createCheckpoint(): Promise<void> {
    if (!threadId) return
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
    if (!threadId) return
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

  const hasDraft = (surface: PanelSurface) =>
    surface.kind === FILE_SURFACE_KIND &&
    surface.path !== undefined &&
    getDraft(slotKey, surface.path) !== null

  function closeTabs(tabs: readonly PanelSurface[]): void {
    onPanelChange((state) => tabs.reduce((next, surface) => closeSurface(next, surface.id), state))
  }

  /** 批量关闭时先确认所有草稿，再一起关闭。 */
  function requestClose(tabs: PanelSurface[]): void {
    if (tabs.some(hasDraft)) {
      setPendingClose(tabs)
      return
    }
    closeTabs(tabs)
  }

  function close(id: string): void {
    requestClose(panel.surfaces.filter((item) => item.id === id))
  }

  async function showFileTabMenu(id: string, point: { x: number; y: number }): Promise<void> {
    const popup = window.pigcodeNative?.popupMenu
    if (!popup) return
    const choice = await popup(
      [
        { id: "close", label: t("files.tabs.close") },
        {
          id: "close-others",
          label: t("files.tabs.closeOthers"),
          enabled: panel.surfaces.length > 1,
        },
        { id: "close-all", label: t("files.tabs.closeAll") },
      ],
      point,
    )
    if (choice === "close") close(id)
    else if (choice === "close-others")
      requestClose(panel.surfaces.filter((surface) => surface.id !== id))
    else if (choice === "close-all") requestClose(panel.surfaces)
  }

  /** 单击复用当前预览，显式打开或编辑过的标签保留。 */
  function openFile(path: string, sourceId: string, preview: boolean): void {
    onPanelChange((state) => {
      const source = state.surfaces.find((surface) => surface.id === sourceId)
      const currentPreview = state.surfaces.find((surface) => surface.preview)
      const alreadyOpen = state.surfaces.some(
        (surface) => surface.kind === FILE_SURFACE_KIND && surface.path === path,
      )
      const replace =
        preview &&
        !alreadyOpen &&
        currentPreview?.path &&
        getDraft(slotKey, currentPreview.path) === null
          ? currentPreview.id
          : source?.kind === "files"
            ? source.id
            : undefined
      return openFileSurface(state, path, nextSurfaceId(), { replace, preview })
    })
  }

  // 文件标签的标题后面带一个圆点表示未保存。
  const surfaces = useMemo(
    () =>
      panel.surfaces.map((surface) =>
        surface.kind === "file" && surface.path
          ? { ...surface, dirty: getDraft(slotKey, surface.path) !== null }
          : surface,
      ),
    // draftVersion 变化时重新读取草稿。
    [panel.surfaces, slotKey, draftVersion],
  )

  const fileProps = {
    connection,
    scope,
    draftKey: slotKey,
    rootName: projectName,
    revision,
    onError,
    onSaved: () => setLocalRevision((count) => count + 1),
    onEdit: activeSurface?.preview
      ? () => onPanelChange((state) => updateSurface(state, activeSurface.id, { preview: false }))
      : undefined,
  }

  const context: WorkbenchContextValue = {
    connection,
    scope,
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
          unavailable={(id) =>
            id === "checkpoint" && !threadId ? "workbench.checkpointNeedsThread" : null
          }
          surfaces={surfaces}
          activeId={panel.activeId}
          onActivate={(id) => onPanelChange((state) => ({ ...state, activeId: id }))}
          onClose={close}
          onFileTabMenu={(id, point) =>
            void showFileTabMenu(id, point).catch((error: unknown) => onError(messageOf(error)))
          }
          onAdd={add}
          controls={controls}
        >
          {activeSurface && (tab === FILE_SURFACE_KIND || tab === "files") ? (
            <Fragment key="file-navigation">
              {surfaceContributions
                .find((item) => item.id === "files")
                ?.render({
                  tab: activeSurface,
                  active: true,
                })}
            </Fragment>
          ) : null}
          {panel.surfaces.map((surface) => {
            if (surface.kind === FILE_SURFACE_KIND || surface.kind === "files") return null
            const active = surface.id === panel.activeId
            // 已经注销的 Surface（插件刚停用）不渲染；App 随即关掉它的标签。
            const contribution = surfaceContributions.find((item) => item.id === surface.kind)
            if (!contribution || (!active && !contribution.keepMounted)) return null
            return (
              <Fragment key={surface.id}>{contribution.render({ tab: surface, active })}</Fragment>
            )
          })}
        </RightPanel>
        <DiscardDraftDialog
          files={pendingClose?.filter(hasDraft).map((surface) => surface.title) ?? null}
          onCancel={() => setPendingClose(null)}
          onDiscard={() => {
            setPendingClose(null)
            if (!pendingClose) return
            for (const surface of pendingClose) {
              if (surface.path && hasDraft(surface)) setDraft(slotKey, surface.path, null)
            }
            closeTabs(pendingClose)
          }}
        />
      </div>
    </WorkbenchContext.Provider>
  )
}
