/** 定时任务页容器：从 Host 拉取任务，并把页面操作转成 schedule.* RPC。 */
import { useCallback, useEffect, useState } from "react"
import type { Schedule } from "@pigcode/contracts"
import { useAppStore } from "@pigcode/client-runtime"
import {
  SchedulesPage,
  type RunNowResult,
  type ScheduleRunsPage,
  type UpdateScheduleInput,
} from "@pigcode/ui-settings"
import type { CoreDeps } from "./app"

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
  const { connection } = deps

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
    void refresh()
  }, [refresh])

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
      threads={state.threads
        .filter((thread) => !thread.parentThreadId)
        .map((thread) => ({ id: thread.id, title: thread.title }))}
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
