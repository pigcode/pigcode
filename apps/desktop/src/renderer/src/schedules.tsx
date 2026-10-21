/** 定时任务设置容器：从 Host 拉取任务，并把页面操作转成 schedule.* RPC。 */
import { useCallback, useEffect, useState } from "react"
import type { Schedule } from "@pigcode/contracts"
import { useAppStore } from "@pigcode/client-runtime"
import { SchedulesPage, type UpdateScheduleInput } from "@pigcode/ui-settings"
import type { CoreDeps } from "./app"

/** 把 unknown 错误转成可展示文本。 */
function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** 定时任务页容器；任务列表在挂载与每次操作后刷新。 */
export function SchedulesContainer({ deps }: { deps: CoreDeps }) {
  const state = useAppStore(deps.store)
  const [schedules, setSchedules] = useState<Schedule[]>([])
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)

  const refresh = useCallback(async (): Promise<void> => {
    try {
      const result = (await deps.connection.call("schedule.list", {})) as Schedule[]
      setSchedules(result)
      setError(null)
    } catch (cause) {
      setError(messageOf(cause))
    } finally {
      setLoading(false)
    }
  }, [deps.connection])

  useEffect(() => {
    void refresh()
  }, [refresh])

  /** 执行一次变更并刷新列表；失败时把错误交给页面展示。 */
  async function mutate(action: () => Promise<unknown>): Promise<void> {
    try {
      await action()
      await refresh()
    } catch (cause) {
      setError(messageOf(cause))
      throw cause
    }
  }

  return (
    <SchedulesPage
      schedules={schedules}
      threads={state.threads.map((thread) => ({ id: thread.id, title: thread.title }))}
      loading={loading}
      error={error}
      onCreate={(input) => mutate(() => deps.connection.call("schedule.create", input))}
      onUpdate={(id: string, patch: UpdateScheduleInput) =>
        mutate(() => deps.connection.call("schedule.update", { id, ...patch }))
      }
      onDelete={(id) => mutate(() => deps.connection.call("schedule.delete", { id }))}
      onRunNow={(id) => mutate(() => deps.connection.call("schedule.runNow", { id }))}
    />
  )
}
