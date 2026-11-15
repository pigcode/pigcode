/** 定时任务页容器：从 Host 拉取任务，并把页面操作转成 schedule.* RPC。 */
import { useCallback, useEffect, useState } from "react"
import type { Schedule } from "@pigcode/contracts"
import { useAppStore, useContributions, type Connection } from "@pigcode/client-runtime"
import {
  SchedulesPage,
  type RunNowResult,
  type ScheduleComposerSources,
  type ScheduleRunsPage,
  type ScheduleWorkspaceControlsProps,
  type UpdateScheduleInput,
} from "@pigcode/ui-settings"
import type { CoreDeps } from "./app"
import { useAgents, useDefaultInstanceId, useModelCatalog } from "./agents"
import { listAgentCommands } from "./agent-commands"
import { DraftWorkspaceControls } from "./draft-workspace-controls"
import { threadOptions } from "./thread-options"
import { useDraftBranches } from "./use-draft-branches"
import { projectFilePaths } from "./workspace-actions"

function ScheduledWorkspace({
  connection,
  projectId,
  worktree,
  onWorktree,
  disabled,
}: ScheduleWorkspaceControlsProps & { connection: Connection }) {
  const git = useDraftBranches(connection, projectId)
  return (
    <DraftWorkspaceControls
      branches={git.branches}
      worktree={worktree ?? null}
      disabled={disabled}
      onOpenBranches={() => void git.refresh()}
      onWorktree={onWorktree}
    />
  )
}

/** 把 unknown 错误转成可展示文本。 */
function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** 定时任务页容器；任务列表在挂载与每次操作后刷新，操作失败时把错误抛给页面。 */
export function SchedulesContainer({
  deps,
  onOpenThread,
}: {
  deps: CoreDeps
  onOpenThread: (threadId: string) => void
}) {
  const state = useAppStore(deps.store)
  const [schedules, setSchedules] = useState<Schedule[]>([])
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [historyRevision, setHistoryRevision] = useState(0)
  const { connection } = deps
  const connected = state.status === "connected"
  const agents = useAgents(connection, state.agentRevision, connected)
  const defaultInstanceId = useDefaultInstanceId(connection, state.agentRevision, connected)
  const { catalog, load } = useModelCatalog(connection, state.agentRevision, connected)
  const addProject = useContributions("command").find((command) => command.id === "add-project")
  const listFiles = useCallback(
    (projectId: string) => projectFilePaths(connection, projectId),
    [connection],
  )
  const mentions = useCallback(
    (projectId: string | null, threadId: string | null) =>
      threadOptions(state.threads, state.projects, threadId, projectId),
    [state.threads, state.projects],
  )
  const loadCommands = useCallback<NonNullable<ScheduleComposerSources["loadCommands"]>>(
    (id, scope, refresh) => listAgentCommands(connection, id, scope, refresh),
    [connection],
  )

  const refresh = useCallback(async (): Promise<void> => {
    try {
      const result = (await connection.call("schedule.list", {})) as Schedule[]
      setSchedules(result)
      setError(null)
    } catch (cause) {
      setError(messageOf(cause))
    } finally {
      setLoading(false)
    }
  }, [connection])

  useEffect(() => {
    if (connected) void refresh()
  }, [connected, refresh])

  useEffect(
    () =>
      connection.onScheduleRunChange(() => {
        void refresh()
        setHistoryRevision((current) => current + 1)
      }),
    [connection, refresh],
  )

  // 运行历史在这个函数变化时重新读取；会话流式输出会频繁刷新 store，函数本身要保持不变。
  const loadRuns = useCallback(
    (id: string, offset: number, limit: number) =>
      connection.call("schedule.runs", { id, offset, limit }) as Promise<ScheduleRunsPage>,
    [connection],
  )

  /** 执行一次变更并刷新列表，把变更的结果交回页面。 */
  async function mutate<T>(action: () => Promise<T>): Promise<T> {
    const result = await action()
    await refresh()
    return result
  }

  return (
    <SchedulesPage
      schedules={schedules}
      projects={state.projects}
      preferredProjectId={state.activeProjectId}
      agentOptions={{ agents, catalog, onLoadModels: load, defaultInstanceId }}
      composerSources={{
        listFiles,
        threadOptions: mentions,
        loadCommands,
        workspaceControls: (props) => (
          <ScheduledWorkspace key={props.projectId} connection={connection} {...props} />
        ),
      }}
      onAddProject={addProject ? () => void addProject.run() : undefined}
      historyRevision={historyRevision}
      threads={state.threads}
      loading={loading}
      error={error}
      onRefresh={() => void refresh()}
      onCreate={(input) => mutate(() => connection.call("schedule.create", input))}
      onUpdate={(id: string, patch: UpdateScheduleInput) =>
        mutate(() => connection.call("schedule.update", { id, ...patch }))
      }
      onDelete={(id) => mutate(() => connection.call("schedule.delete", { id }))}
      onRunNow={(id) =>
        mutate(() => connection.call("schedule.runNow", { id }) as Promise<RunNowResult>)
      }
      onLoadRuns={loadRuns}
      onDeleteRun={(runId) => connection.call("schedule.deleteRun", { id: runId })}
      onOpenThread={onOpenThread}
    />
  )
}
