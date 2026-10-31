/**
 * 右侧面板容器：把浏览器、终端、文件、Diff、PR 与检查点 surface 接到 Host RPC，
 * 插件注册的标签挂在同样的标签栏与外框里。
 */
import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react"
import { ChevronDown, Loader2, Plus, Trash2, Unplug } from "lucide-react"
import type { Connection } from "@pigcode/client-runtime"
import type { ClientSurface } from "@pigcode/plugin-sdk"
import { Button, EmptyState, Select, useLocale } from "@pigcode/ui-primitives"
import { PluginContentHost } from "@pigcode/ui-shell"
import {
  CheckpointPanel,
  DiffView,
  PrPanel,
  RightPanel,
  WorktreePicker,
  addPluginSurface,
  addSurface,
  closeSurface,
  openFileSurface,
  type CheckpointPhase,
  type PanelSurface,
  type PanelSurfaceKind,
  type PanelSurfaceState,
  type SurfaceKind,
} from "@pigcode/ui-workbench"
import { BrowserSurface } from "./browser-surface"
import { DiscardDraftDialog } from "./discard-draft-dialog"
import { getDraft, setDraft, useDraftVersion } from "./file-drafts"
import { FileSurface, FilesSurface } from "./files-surface"
import { TerminalSurface } from "./terminal-surface"
import { usePullRequest } from "./use-pull-request"
import { useWorktrees } from "./use-worktrees"
import { browserLabels, prPanelLabels, rightPanelLabels, surfaceTitle } from "./workbench-labels"

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
  /** 插件注册的右栏标签。 */
  pluginSurfaces?: readonly ClientSurface[]
}

let surfaceSeq = 0

/** 生成 surface id；只需在本窗口内唯一。 */
function nextSurfaceId(): string {
  surfaceSeq += 1
  return `surface-${surfaceSeq}`
}

/** checkpoint.list 返回的记录；只保留 UI 需要的字段。 */
interface CheckpointRecord {
  id: string
  runId: string | null
  phase: CheckpointPhase
  commitSha: string | null
  label: string | null
  createdAt: string
}

/** Diff 基准下拉里一个 checkpoint 的文字：标签或阶段，加创建时间。 */
function checkpointLabel(checkpoint: CheckpointRecord): string {
  return `${checkpoint.label ?? checkpoint.phase} · ${checkpoint.createdAt}`
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
  pluginSurfaces = [],
}: WorkbenchPanelProps) {
  const { t } = useLocale()
  const tab: PanelSurfaceKind | null =
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

  const labels = rightPanelLabels(t)
  const prLabels = prPanelLabels(t)
  const webLabels = browserLabels(t)

  function add(kind: SurfaceKind): void {
    onPanelChange((state) =>
      addSurface(state, kind, nextSurfaceId(), (index) => surfaceTitle(t, kind, index)),
    )
  }

  function addPlugin(id: string): void {
    const plugin = pluginSurfaces.find((surface) => surface.id === id)
    if (plugin) onPanelChange((state) => addPluginSurface(state, plugin, nextSurfaceId()))
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

  const content: Record<"diff" | "checkpoint" | "pr", ReactNode> = {
    diff: (
      <div className="workbench-diff">
        {committed.length > 0 ? (
          <div className="workbench-diff-base">
            <Select.Root
              value={baseSha ?? null}
              onValueChange={(next) => setDiffBase(typeof next === "string" && next ? next : null)}
            >
              <Select.Label>{t("workbench.diffBase")}</Select.Label>
              <Select.Trigger className="input select-trigger workbench-diff-base-select">
                <Select.Value className="grow truncate">
                  {(value: string | null) => {
                    const checkpoint = committed.find((item) => item.commitSha === value)
                    return checkpoint ? checkpointLabel(checkpoint) : "HEAD"
                  }}
                </Select.Value>
                <ChevronDown className="ic ic-sm" aria-hidden="true" />
              </Select.Trigger>
              <Select.Portal>
                <Select.Positioner sideOffset={6} alignItemWithTrigger={false}>
                  <Select.Popup>
                    {[...committed].reverse().map((checkpoint) => (
                      <Select.Item key={checkpoint.id} value={checkpoint.commitSha ?? ""}>
                        <Select.ItemText>{checkpointLabel(checkpoint)}</Select.ItemText>
                      </Select.Item>
                    ))}
                  </Select.Popup>
                </Select.Positioner>
              </Select.Portal>
            </Select.Root>
          </div>
        ) : null}
        {diffError ? (
          <p className="workbench-error">{diffError}</p>
        ) : diffLoading ? (
          <EmptyState icon={<Loader2 className="ic spin" />} title={t("workbench.diff.loading")} />
        ) : (
          <DiffView
            diff={diff}
            emptyText={t("workbench.diff.empty")}
            emptyHint={t("workbench.diff.emptyHint")}
          />
        )}
      </div>
    ),
    checkpoint: (
      <div className="workbench-checkpoints">
        <header className="workbench-section-header">
          <span>{t("workbench.checkpoint")}</span>
          <Button
            variant="secondary"
            size="sm"
            disabled={checkpointBusy}
            onClick={() => void createCheckpoint()}
          >
            {t("workbench.createCheckpoint")}
          </Button>
        </header>
        {checkpointError ? <p className="workbench-error">{checkpointError}</p> : null}
        <CheckpointPanel
          checkpoints={checkpoints}
          onRestore={restoreCheckpoint}
          restoring={checkpointBusy}
          emptyText={t("workbench.checkpoint.empty")}
          emptyHint={t("workbench.checkpoint.emptyHint")}
        />
      </div>
    ),
    pr: (
      <PrPanel
        pullRequest={pr.pullRequest}
        loading={pr.loading}
        creating={pr.creating}
        error={pr.error}
        onCreate={pr.create}
        labels={prLabels}
      />
    ),
  }

  return (
    <div className="workbench">
      <RightPanel
        threadId={threadId}
        surfaces={surfaces}
        activeId={panel.activeId}
        onActivate={(id) => onPanelChange((state) => ({ ...state, activeId: id }))}
        onClose={close}
        onAdd={add}
        plugins={pluginSurfaces}
        onAddPlugin={addPlugin}
        controls={controls}
        labels={labels}
      >
        {panel.surfaces.map((surface) => {
          const active = surface.id === panel.activeId
          if (surface.kind === "terminal") {
            return (
              <div key={surface.id} className="surface-pane" hidden={!active}>
                <TerminalSurface
                  connection={connection}
                  threadId={threadId}
                  active={active}
                  tools={
                    <>
                      <Button
                        variant="plain"
                        size="icon"
                        type="button"
                        aria-label={t("terminal.new")}
                        title={t("terminal.new")}
                        onClick={() => add("terminal")}
                      >
                        <Plus className="ic ic-sm" aria-hidden="true" />
                      </Button>
                      <Button
                        variant="plain"
                        size="icon"
                        type="button"
                        aria-label={t("terminal.kill")}
                        title={t("terminal.kill")}
                        onClick={() => close(surface.id)}
                      >
                        <Trash2 className="ic ic-sm" aria-hidden="true" />
                      </Button>
                    </>
                  }
                />
              </div>
            )
          }
          if (surface.kind === "browser") {
            return (
              <div key={surface.id} className="surface-pane" hidden={!active}>
                <BrowserSurface id={surface.id} labels={webLabels} />
              </div>
            )
          }
          if (!active) return null
          if (surface.kind === "files") {
            return (
              <div key={surface.id} className="surface-pane workbench-files">
                <div className="workbench-worktree-compact">
                  <WorktreePicker
                    worktrees={worktrees.worktrees}
                    activePath={worktrees.activePath}
                    onCreate={worktrees.create}
                    onSwitch={worktrees.switchTo}
                    onRemove={worktrees.remove}
                    busy={worktrees.busy}
                    compact
                  />
                </div>
                <FilesSurface {...fileProps} onOpenFile={(path) => openFile(path, surface.id)} />
              </div>
            )
          }
          if (surface.kind === "file") {
            return (
              <div key={surface.id} className="surface-pane">
                <FileSurface
                  {...fileProps}
                  path={surface.path ?? ""}
                  line={surface.line}
                  onOpenFile={(path) => openFile(path)}
                />
              </div>
            )
          }
          if (surface.kind === "plugin") {
            const plugin = pluginSurfaces.find((item) => item.id === surface.plugin)
            return (
              <div key={surface.id} className="surface-pane surface-scroll">
                {plugin ? (
                  <PluginContentHost id={plugin.id} render={plugin.render} kind="surface" />
                ) : (
                  <EmptyState
                    icon={<Unplug className="ic" />}
                    title={t("plugins.surfaceGone")}
                    description={t("plugins.surfaceGoneHint")}
                  />
                )}
              </div>
            )
          }
          return (
            <div key={surface.id} className="surface-pane surface-scroll">
              {content[surface.kind]}
            </div>
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
  )
}
