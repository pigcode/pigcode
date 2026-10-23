/** 定时任务设置页：创建固定间隔任务，并管理启停、立即运行与删除。 */
import { useEffect, useState, type FormEvent } from "react"
import type { Schedule } from "@pigcode/contracts"
import {
  Button,
  Input,
  SettingPage,
  SettingRow,
  SettingSection,
  Switch,
  Textarea,
  useLocale,
} from "@pigcode/ui-primitives"

/** 线程选项；只暴露选择器需要的字段。 */
export interface ScheduleThreadOption {
  id: string
  title: string
}

/** 创建任务的输入；与 schedule.create 命令参数一致。 */
export interface CreateScheduleInput {
  threadId: string
  prompt: string
  intervalSeconds: number
  enabled: boolean
}

/** 更新任务的输入；只提交变化的字段。 */
export interface UpdateScheduleInput {
  prompt?: string
  intervalSeconds?: number
  enabled?: boolean
}

/** 定时任务页属性；RPC 由父容器完成。 */
export interface SchedulesPageProps {
  schedules: Schedule[]
  threads: ScheduleThreadOption[]
  loading?: boolean | undefined
  error?: string | null | undefined
  onCreate: (input: CreateScheduleInput) => void | Promise<void>
  onUpdate: (id: string, patch: UpdateScheduleInput) => void | Promise<void>
  onDelete: (id: string) => void | Promise<void>
  onRunNow: (id: string) => void | Promise<void>
}

/** 默认间隔；与常见的每分钟巡检一致。 */
const DEFAULT_INTERVAL_SECONDS = 60

/** 把 ISO 时间显示为本地时间；空值显示 never。 */
function formatTime(value: string | null, never: string): string {
  return value ? new Date(value).toLocaleString() : never
}

/** 渲染定时任务管理与创建表单。 */
export function SchedulesPage({
  schedules,
  threads,
  loading = false,
  error = null,
  onCreate,
  onUpdate,
  onDelete,
  onRunNow,
}: SchedulesPageProps) {
  const { t } = useLocale()
  const [threadId, setThreadId] = useState(threads[0]?.id ?? "")
  const [prompt, setPrompt] = useState("")
  const [intervalValue, setIntervalValue] = useState(String(DEFAULT_INTERVAL_SECONDS))
  const [submitting, setSubmitting] = useState(false)
  const intervalSeconds = Number.parseInt(intervalValue, 10)
  const trimmedPrompt = prompt.trim()

  // 线程列表晚于页面加载时补上默认选择；当前线程被删除时回到第一个。
  useEffect(() => {
    if (threads.some((thread) => thread.id === threadId)) return
    setThreadId(threads[0]?.id ?? "")
  }, [threadId, threads])
  const canCreate =
    threadId.length > 0 &&
    trimmedPrompt.length > 0 &&
    Number.isInteger(intervalSeconds) &&
    intervalSeconds > 0 &&
    intervalSeconds <= 2_147_483

  /** 提交创建表单；失败时保留输入，错误由父容器展示。 */
  async function submit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault()
    if (!canCreate || submitting) return
    setSubmitting(true)
    try {
      await onCreate({
        threadId,
        prompt: trimmedPrompt,
        intervalSeconds,
        enabled: true,
      })
      setPrompt("")
    } catch {
      // 错误由父容器的 error 属性展示，这里只保留用户输入。
    } finally {
      setSubmitting(false)
    }
  }

  /** 按线程 id 找到展示名；线程被删除时回退到 id。 */
  function threadTitle(id: string): string {
    return threads.find((thread) => thread.id === id)?.title ?? id
  }

  return (
    <SettingPage title={t("settings.schedules.pageTitle")} sub={t("settings.schedules.subtitle")}>
      {error ? (
        <p className="workbench-error" role="alert">
          {error}
        </p>
      ) : null}
      <form onSubmit={(event) => void submit(event)}>
        <SettingSection title={t("settings.schedules.new")}>
          {threads.length === 0 ? (
            <div className="empty">{t("settings.schedules.noThreads")}</div>
          ) : null}
          <SettingRow title={t("settings.schedules.thread")}>
            <select
              aria-label={t("settings.schedules.thread")}
              value={threadId}
              disabled={threads.length === 0 || submitting}
              onChange={(event) => setThreadId(event.target.value)}
            >
              {threads.map((thread) => (
                <option key={thread.id} value={thread.id}>
                  {thread.title}
                </option>
              ))}
            </select>
          </SettingRow>
          <SettingRow title={t("settings.schedules.prompt")}>
            <Textarea
              aria-label={t("settings.schedules.prompt")}
              placeholder={t("settings.schedules.promptPlaceholder")}
              value={prompt}
              rows={2}
              disabled={submitting}
              onChange={(event) => setPrompt(event.target.value)}
            />
          </SettingRow>
          <SettingRow title={t("settings.schedules.interval")}>
            <Input
              aria-label={t("settings.schedules.interval")}
              type="number"
              min={1}
              step={1}
              value={intervalValue}
              disabled={submitting}
              onChange={(event) => setIntervalValue(event.target.value)}
            />
          </SettingRow>
        </SettingSection>
        <div style={{ display: "flex", justifyContent: "flex-end" }}>
          <Button type="submit" size="sm" disabled={!canCreate || submitting}>
            {submitting ? t("settings.schedules.creating") : t("settings.schedules.create")}
          </Button>
        </div>
      </form>

      <SettingSection title={t("settings.schedules.list")}>
        {loading ? <div className="empty">{t("settings.schedules.loading")}</div> : null}
        {!loading && schedules.length === 0 ? (
          <div className="empty">{t("settings.schedules.empty")}</div>
        ) : null}
        {schedules.map((schedule) => (
          <SettingRow
            key={schedule.id}
            title={schedule.prompt}
            description={
              <>
                {threadTitle(schedule.threadId)} · {t("settings.schedules.every")}{" "}
                {schedule.intervalSeconds} {t("settings.schedules.seconds")} ·{" "}
                {t("settings.schedules.nextRun")}{" "}
                {formatTime(schedule.nextRunAt, t("settings.schedules.never"))}
                {schedule.lastRunAt
                  ? ` · ${t("settings.schedules.lastRun")} ${formatTime(
                      schedule.lastRunAt,
                      t("settings.schedules.never"),
                    )}`
                  : null}
              </>
            }
          >
            <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <Switch
                checked={schedule.enabled}
                aria-label={`${t("settings.schedules.enabled")} ${schedule.prompt}`}
                onCheckedChange={(checked) => {
                  void Promise.resolve(onUpdate(schedule.id, { enabled: checked })).catch(
                    () => undefined,
                  )
                }}
              />
              <Button
                size="sm"
                onClick={() => {
                  void Promise.resolve(onRunNow(schedule.id)).catch(() => undefined)
                }}
              >
                {t("settings.schedules.runNow")}
              </Button>
              <Button
                size="sm"
                variant="danger"
                onClick={() => {
                  void Promise.resolve(onDelete(schedule.id)).catch(() => undefined)
                }}
              >
                {t("settings.schedules.delete")}
              </Button>
            </div>
          </SettingRow>
        ))}
      </SettingSection>
    </SettingPage>
  )
}
