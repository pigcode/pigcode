/** 定时任务页容器：聚合所有主机的定时任务，并在新建与操作时路由到对应主机 RPC。 */
import { useCallback, useEffect, useMemo, useState } from "react"
import { HOST_LOCAL_ID, type HostSummary } from "@pigcode/contracts"
import {
  HostPool,
  useAppStore,
  useContributions,
  useHostPool,
  type Connection,
} from "@pigcode/client-runtime"
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

/** 定时任务页容器；支持多主机混排聚合展示与新建/编辑时自动切换到任务归属主机。 */
export function SchedulesContainer({
  deps,
  hostPool,
  preferredHostId,
  onOpenThread,
}: {
  deps: CoreDeps
  hostPool?: HostPool | undefined
  preferredHostId?: string | undefined
  onOpenThread: (threadId: string, hostId?: string) => void
}) {
  const fallbackPool = useMemo(
    () => new HostPool({ localConnection: deps.connection, localStore: deps.store }),
    [deps.connection, deps.store],
  )
  const pool = hostPool ?? fallbackPool
  const poolSnap = useHostPool(pool)
  const [pickedHostId, setPickedHostId] = useState<string>(() =>
    pool.resolveTargetHostId(preferredHostId),
  )
  const createHostId = pool.resolveTargetHostId(pickedHostId)
  const [editingScheduleId, setEditingScheduleId] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [historyRevision, setHistoryRevision] = useState(0)

  const mixed = useMemo(() => pool.mixedSchedules(), [pool, poolSnap.revision])
  const schedules = useMemo(() => mixed.map((entry) => entry.schedule), [mixed])
  const scheduleHosts = useMemo<Record<string, HostSummary>>(() => {
    const out: Record<string, HostSummary> = {}
    for (const entry of mixed) out[entry.schedule.id] = entry.host
    return out
  }, [mixed])

  const ownerHost = editingScheduleId ? scheduleHosts[editingScheduleId] : undefined
  const activeEditorHostId = ownerHost?.id ?? createHostId
  const activeSlot = pool.slot(activeEditorHostId)
  const connection = activeSlot.connection
  const state = useAppStore(activeSlot.store)
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
    (id, scope, refreshFlag) => listAgentCommands(connection, id, scope, refreshFlag),
    [connection],
  )

  const refresh = useCallback(async (): Promise<void> => {
    setLoading(true)
    setError(null)
    try {
      const onlineIds = pool
        .listHosts()
        .filter((h) => h.status === "connected")
        .map((h) => h.id)
      await Promise.all(onlineIds.map((id) => pool.refreshHostSchedules(id)))
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setLoading(false)
    }
  }, [pool])

  useEffect(() => {
    void refresh()
  }, [refresh, poolSnap.hosts.length])

  useEffect(
    () =>
      connection.onScheduleRunChange(() => {
        void pool.refreshHostSchedules(activeEditorHostId)
        setHistoryRevision((current) => current + 1)
      }),
    [connection, pool, activeEditorHostId],
  )

  const loadRuns = useCallback(
    (id: string, offset: number, limit: number) => {
      const ownerId = scheduleHosts[id]?.id ?? activeEditorHostId
      return pool.slot(ownerId).connection.call("schedule.runs", {
        id,
        offset,
        limit,
      }) as Promise<ScheduleRunsPage>
    },
    [pool, scheduleHosts, activeEditorHostId],
  )

  async function mutateOn<T>(
    targetId: string,
    action: (conn: Connection) => Promise<T>,
  ): Promise<T> {
    const slot = pool.slot(targetId)
    const result = await action(slot.connection)
    await pool.refreshHostSchedules(slot.id)
    return result
  }

  return (
    <SchedulesPage
      schedules={schedules}
      projects={state.projects}
      preferredProjectId={state.activeProjectId}
      hosts={poolSnap.hosts.length >= 2 ? poolSnap.hosts : undefined}
      targetHostId={createHostId}
      onTargetHostChange={setPickedHostId}
      scheduleHosts={scheduleHosts}
      onEditingScheduleChange={(editing) => setEditingScheduleId(editing?.id ?? null)}
      agentOptions={{ agents, catalog, onLoadModels: load, defaultInstanceId }}
      composerSources={{
        listFiles,
        threadOptions: mentions,
        loadCommands,
        workspaceControls: (props) => (
          <ScheduledWorkspace
            key={`${activeEditorHostId}:${props.projectId}`}
            connection={connection}
            {...props}
          />
        ),
      }}
      onAddProject={addProject ? () => void addProject.run() : undefined}
      historyRevision={historyRevision}
      threads={state.threads}
      loading={loading}
      error={error}
      onRefresh={() => void refresh()}
      onCreate={(input) => mutateOn(createHostId, (conn) => conn.call("schedule.create", input))}
      onUpdate={(id: string, patch: UpdateScheduleInput) =>
        mutateOn(scheduleHosts[id]?.id ?? activeEditorHostId, (conn) =>
          conn.call("schedule.update", { id, ...patch }),
        )
      }
      onDelete={(id) =>
        mutateOn(scheduleHosts[id]?.id ?? HOST_LOCAL_ID, (conn) =>
          conn.call("schedule.delete", { id }),
        )
      }
      onRunNow={(id) =>
        mutateOn(
          scheduleHosts[id]?.id ?? activeEditorHostId,
          (conn) => conn.call("schedule.runNow", { id }) as Promise<RunNowResult>,
        )
      }
      onLoadRuns={loadRuns}
      onDeleteRun={(runId) => connection.call("schedule.deleteRun", { id: runId })}
      onOpenThread={(threadId) => onOpenThread(threadId, activeEditorHostId)}
    />
  )
}
