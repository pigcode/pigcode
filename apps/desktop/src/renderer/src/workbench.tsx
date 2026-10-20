/** 工作台容器：把右栏的文件、Diff、终端与 checkpoint 面板接到 Host RPC。 */
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react"
import type { Connection } from "@pigcode/client-runtime"
import { Button, useLocale } from "@pigcode/ui-primitives"
import {
  CheckpointPanel,
  DiffView,
  FilePreview,
  FileTree,
  RightPanel,
  TerminalView,
  WorktreePicker,
  type CheckpointPhase,
  type FilePreviewFile,
  type RightPanelTab,
  type TerminalHandle,
} from "@pigcode/ui-workbench"

/** 工作台属性；线程切换时由父组件用 key 重新挂载以释放终端。 */
export interface WorkbenchPanelProps {
  connection: Connection
  threadId: string
  onClose: () => void
  onError: (message: string) => void
}

/** workspace.tree 返回的条目。 */
interface WorkspaceEntry {
  path: string
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

/** worktree.create/switch 返回的记录。 */
interface WorktreeRecord {
  id: string
  path: string
  branch: string | null
}

/** terminal.open 返回的会话。 */
interface TerminalSession {
  id: string
  cols: number
  rows: number
}

/** 终端初始尺寸；xterm 挂载后会通过 fit 与 resize 修正。 */
const TERMINAL_COLS = 80
const TERMINAL_ROWS = 24

/** 把 unknown 错误转成可展示文本。 */
function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** 带结果类型的 RPC 调用；方法名与参数由 contracts 校验。 */
async function callRpc<T>(connection: Connection, method: string, params: unknown): Promise<T> {
  return (await connection.call(method, params)) as T
}

/** 工作台右栏；每个 tab 的数据只在激活时加载。 */
export function WorkbenchPanel({ connection, threadId, onClose, onError }: WorkbenchPanelProps) {
  const { t } = useLocale()
  const [tab, setTab] = useState<RightPanelTab>("files")
  const [entries, setEntries] = useState<WorkspaceEntry[]>([])
  const [treeError, setTreeError] = useState<string | null>(null)
  const [selectedPath, setSelectedPath] = useState<string | null>(null)
  const [file, setFile] = useState<FilePreviewFile | null>(null)
  const [fileLoading, setFileLoading] = useState(false)
  const [fileError, setFileError] = useState<string | null>(null)
  const [checkpoints, setCheckpoints] = useState<CheckpointRecord[]>([])
  const [checkpointError, setCheckpointError] = useState<string | null>(null)
  const [checkpointBusy, setCheckpointBusy] = useState(false)
  const [diff, setDiff] = useState("")
  const [diffLoading, setDiffLoading] = useState(false)
  const [diffError, setDiffError] = useState<string | null>(null)
  const [diffBase, setDiffBase] = useState<string | null>(null)
  const [terminalId, setTerminalId] = useState<string | null>(null)
  const [terminalError, setTerminalError] = useState<string | null>(null)
  const [worktrees, setWorktrees] = useState<WorktreeRecord[]>([])
  const [activeWorktree, setActiveWorktree] = useState<string | null>(null)
  const [worktreeBusy, setWorktreeBusy] = useState(false)
  const terminalHandle = useRef<TerminalHandle | null>(null)

  // 文件树：每次进入 Files tab 都重新读取，反映终端或外部编辑后的状态。
  useEffect(() => {
    if (tab !== "files") return undefined
    let cancelled = false
    setTreeError(null)
    void callRpc<WorkspaceEntry[]>(connection, "workspace.tree", { threadId })
      .then((list) => {
        if (!cancelled) setEntries(list)
      })
      .catch((error: unknown) => {
        if (!cancelled) setTreeError(messageOf(error))
      })
    return () => {
      cancelled = true
    }
  }, [tab, threadId, connection])

  // 选中文件后通过 Host 读取，Renderer 不触碰磁盘。
  useEffect(() => {
    if (!selectedPath) {
      setFile(null)
      setFileError(null)
      return undefined
    }
    let cancelled = false
    setFileLoading(true)
    setFileError(null)
    void callRpc<FilePreviewFile>(connection, "workspace.readFile", {
      threadId,
      path: selectedPath,
    })
      .then((result) => {
        if (!cancelled) setFile(result)
      })
      .catch((error: unknown) => {
        if (!cancelled) setFileError(messageOf(error))
      })
      .finally(() => {
        if (!cancelled) setFileLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [selectedPath, threadId, connection])

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
  const headSha = useMemo(() => {
    const finals = committed.filter((checkpoint) => checkpoint.phase !== "baseline")
    return finals[finals.length - 1]?.commitSha ?? "HEAD"
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

  // 终端：进入 Terminal tab 时打开 PTY；离开 tab 或卸载时关闭并释放订阅。
  useEffect(() => {
    if (tab !== "terminal") return undefined
    let cancelled = false
    let openedId: string | null = null
    setTerminalError(null)
    void callRpc<TerminalSession>(connection, "terminal.open", {
      threadId,
      cols: TERMINAL_COLS,
      rows: TERMINAL_ROWS,
    })
      .then((session) => {
        openedId = session.id
        if (cancelled) {
          void connection.call("terminal.close", { terminalId: session.id }).catch(() => undefined)
          return
        }
        setTerminalId(session.id)
      })
      .catch((error: unknown) => {
        if (!cancelled) setTerminalError(messageOf(error))
      })
    return () => {
      cancelled = true
      setTerminalId(null)
      if (openedId) {
        void connection.call("terminal.close", { terminalId: openedId }).catch(() => undefined)
      }
    }
  }, [tab, threadId, connection])

  // 只把当前终端 id 的输出写进 xterm；订阅随 terminalId 变化或卸载释放。
  useEffect(() => {
    if (!terminalId) return undefined
    return connection.onTerminalOutput((output) => {
      if (output.terminalId === terminalId) terminalHandle.current?.write(output.data)
    })
  }, [connection, terminalId])

  function sendTerminalData(data: string): void {
    if (!terminalId) return
    void connection
      .call("terminal.write", { terminalId, data })
      .catch((error: unknown) => setTerminalError(messageOf(error)))
  }

  function resizeTerminal(cols: number, rows: number): void {
    if (!terminalId) return
    void connection
      .call("terminal.resize", { terminalId, cols, rows })
      .catch((error: unknown) => setTerminalError(messageOf(error)))
  }

  function handleTerminalReady(handle: TerminalHandle | null): void {
    terminalHandle.current = handle
    handle?.focus()
  }

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
      await refreshCheckpoints()
    } catch (error) {
      onError(messageOf(error))
    } finally {
      setCheckpointBusy(false)
    }
  }

  /** worktree 列表没有 list RPC；这里只保留本次会话内创建过的记录。 */
  async function createWorktree(): Promise<void> {
    setWorktreeBusy(true)
    try {
      const worktree = await callRpc<WorktreeRecord>(connection, "worktree.create", { threadId })
      setWorktrees((current) => [
        ...current.filter((item) => item.path !== worktree.path),
        worktree,
      ])
      setActiveWorktree(worktree.path)
    } catch (error) {
      onError(messageOf(error))
    } finally {
      setWorktreeBusy(false)
    }
  }

  async function switchWorktree(path: string): Promise<void> {
    setWorktreeBusy(true)
    try {
      const worktree = await callRpc<WorktreeRecord>(connection, "worktree.switch", {
        threadId,
        path,
      })
      setActiveWorktree(worktree.path)
    } catch (error) {
      onError(messageOf(error))
    } finally {
      setWorktreeBusy(false)
    }
  }

  async function removeWorktree(): Promise<void> {
    setWorktreeBusy(true)
    try {
      await connection.call("worktree.remove", { threadId })
      setWorktrees((current) => current.filter((item) => item.path !== activeWorktree))
      setActiveWorktree(null)
    } catch (error) {
      onError(messageOf(error))
    } finally {
      setWorktreeBusy(false)
    }
  }

  const labels: Record<RightPanelTab, string> = {
    files: t("workbench.files"),
    diff: t("workbench.diff"),
    terminal: t("workbench.terminal"),
    checkpoint: t("workbench.checkpoint"),
  }

  const tabs: Record<RightPanelTab, ReactNode> = {
    files: (
      <div className="workbench-files">
        {treeError ? (
          <p className="workbench-error">{treeError}</p>
        ) : (
          <FileTree entries={entries} selectedPath={selectedPath} onSelect={setSelectedPath} />
        )}
        <FilePreview file={file} loading={fileLoading} error={fileError} />
      </div>
    ),
    diff: (
      <div className="workbench-diff">
        {committed.length > 0 ? (
          <label className="workbench-diff-base">
            <span>{t("workbench.diffBase")}</span>
            <select
              value={baseSha ?? ""}
              onChange={(event) => setDiffBase(event.target.value || null)}
            >
              {[...committed].reverse().map((checkpoint) => (
                <option key={checkpoint.id} value={checkpoint.commitSha ?? ""}>
                  {checkpoint.label ?? checkpoint.phase} · {checkpoint.createdAt}
                </option>
              ))}
            </select>
          </label>
        ) : null}
        {diffError ? (
          <p className="workbench-error">{diffError}</p>
        ) : diffLoading ? (
          <p className="workbench-empty">正在读取 diff…</p>
        ) : (
          <DiffView diff={diff} />
        )}
      </div>
    ),
    terminal: (
      <div className="workbench-terminal">
        {terminalError ? (
          <p className="workbench-error">{terminalError}</p>
        ) : terminalId ? (
          <TerminalView
            onData={sendTerminalData}
            onResize={resizeTerminal}
            onReady={handleTerminalReady}
          />
        ) : (
          // terminal.open 是异步 RPC；会话就绪前不挂载 xterm，避免输入被静默丢弃。
          <p className="workbench-empty">{t("workbench.terminalOpening")}</p>
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
        />
      </div>
    ),
  }

  return (
    <div className="workbench">
      <div className="workbench-worktrees">
        <WorktreePicker
          worktrees={worktrees}
          activePath={activeWorktree}
          onCreate={createWorktree}
          onSwitch={switchWorktree}
          onRemove={removeWorktree}
          busy={worktreeBusy}
        />
      </div>
      <RightPanel
        threadId={threadId}
        tabs={tabs}
        active={tab}
        onTab={setTab}
        onClose={onClose}
        labels={labels}
      />
    </div>
  )
}
