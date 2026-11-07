/** 定时任务的运行历史：每次触发一行，能跳到当时的会话或删掉这条记录；新的在前，每页 20 条。 */
import { useEffect, useState } from "react"
import { ChevronLeft, ChevronRight, MessageSquareText, Trash2 } from "lucide-react"
import type { ScheduleRun, ScheduleRunStatus } from "@pigcode/contracts"
import {
  Button,
  Spinner,
  StatusDot,
  Tooltip,
  formatDateTime,
  toHostError,
  useLocale,
  type StatusTone,
} from "@pigcode/ui-primitives"
import { RUN_STATUS_KEYS, fill, formatRunDuration, runReason } from "./schedule-format"

export const RUNS_PAGE_SIZE = 20

/** 一页运行记录与总条数。 */
export interface ScheduleRunsPage {
  runs: ScheduleRun[]
  total: number
}

const TONES: Record<ScheduleRunStatus, StatusTone> = {
  running: "running",
  succeeded: "ready",
  failed: "error",
  stopped: "idle",
  skipped: "warning",
}

/** 行尾的小图标按钮，悬停时说明用途。 */
function RowAction({
  label,
  danger,
  onClick,
  children,
}: {
  label: string
  danger?: boolean
  onClick: () => void
  children: React.ReactNode
}) {
  return (
    <Tooltip.Root>
      <Tooltip.Trigger
        delay={300}
        render={
          <Button
            variant="ghost"
            size="icon"
            className="schedule-run-action"
            data-danger={danger ? "" : undefined}
            aria-label={label}
            onClick={onClick}
          />
        }
      >
        {children}
      </Tooltip.Trigger>
      <Tooltip.Portal>
        <Tooltip.Positioner side="top" sideOffset={6}>
          <Tooltip.Popup>{label}</Tooltip.Popup>
        </Tooltip.Positioner>
      </Tooltip.Portal>
    </Tooltip.Root>
  )
}

export function ScheduleHistory({
  scheduleId,
  onLoadRuns,
  onDeleteRun,
  onOpenThread,
}: {
  scheduleId: string
  onLoadRuns: (id: string, offset: number, limit: number) => Promise<ScheduleRunsPage>
  onDeleteRun: (runId: string) => Promise<unknown>
  onOpenThread?: ((threadId: string) => void) | undefined
}) {
  const { t, locale } = useLocale()
  const [page, setPage] = useState(0)
  const [data, setData] = useState<ScheduleRunsPage | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [version, setVersion] = useState(0)

  useEffect(() => {
    let live = true
    setError(null)
    onLoadRuns(scheduleId, page * RUNS_PAGE_SIZE, RUNS_PAGE_SIZE).then(
      (result) => {
        if (!live) return
        // 删掉最后一页仅剩的一条后，这一页空了：回到还有记录的最后一页。
        const last = Math.max(0, Math.ceil(result.total / RUNS_PAGE_SIZE) - 1)
        if (result.runs.length === 0 && page > last) setPage(last)
        else setData(result)
      },
      (cause: unknown) => {
        if (live) setError(toHostError(cause).message)
      },
    )
    return () => {
      live = false
    }
  }, [scheduleId, page, version, onLoadRuns])

  if (error) {
    return (
      <p className="error-text schedule-runs-note">
        {fill(t("schedules.runs.loadFailed"), { reason: error })}
      </p>
    )
  }
  if (!data) {
    return (
      <p className="hint schedule-runs-note">
        <Spinner className="ic ic-sm" /> {t("schedules.runs.loading")}
      </p>
    )
  }
  if (data.total === 0)
    return <p className="hint schedule-runs-note">{t("schedules.runs.empty")}</p>

  const pages = Math.max(1, Math.ceil(data.total / RUNS_PAGE_SIZE))
  return (
    <div className="schedule-runs">
      <table>
        <thead>
          <tr>
            <th scope="col">{t("schedules.runs.col.triggered")}</th>
            <th scope="col">{t("schedules.runs.col.source")}</th>
            <th scope="col">{t("schedules.runs.col.status")}</th>
            <th scope="col">{t("schedules.runs.col.duration")}</th>
            <th scope="col" className="schedule-runs-actions">
              <span className="sr-only">{t("schedules.runs.col.actions")}</span>
            </th>
          </tr>
        </thead>
        <tbody>
          {data.runs.map((run) => {
            const reason = runReason(run.error, t)
            return (
              <tr key={run.id} data-run={run.id}>
                <td className="schedule-runs-time">{formatDateTime(run.triggeredAt, locale)}</td>
                <td className="muted">{t(`schedules.runs.source.${run.source}`)}</td>
                <td>
                  <span className="schedule-runs-status" data-status={run.status}>
                    <StatusDot tone={TONES[run.status]} />
                    <span className="schedule-runs-label">{t(RUN_STATUS_KEYS[run.status])}</span>
                    {reason ? (
                      <span className="schedule-runs-reason truncate" title={reason}>
                        {reason}
                      </span>
                    ) : null}
                  </span>
                </td>
                <td className="muted">
                  {formatRunDuration(run.triggeredAt, run.finishedAt, locale) ?? "—"}
                </td>
                <td className="schedule-runs-actions">
                  {onOpenThread && run.runId ? (
                    <RowAction
                      label={t("schedules.runs.openThread")}
                      onClick={() => onOpenThread(run.threadId)}
                    >
                      <MessageSquareText className="ic" aria-hidden="true" />
                    </RowAction>
                  ) : null}
                  <RowAction
                    label={t("schedules.runs.delete")}
                    danger
                    onClick={() => {
                      void onDeleteRun(run.id).then(
                        () => setVersion((current) => current + 1),
                        (cause: unknown) => setError(toHostError(cause).message),
                      )
                    }}
                  >
                    <Trash2 className="ic" aria-hidden="true" />
                  </RowAction>
                </td>
              </tr>
            )
          })}
        </tbody>
      </table>
      {pages > 1 ? (
        <div className="schedule-runs-pager">
          <Button
            variant="ghost"
            size="icon"
            aria-label={t("schedules.runs.prev")}
            disabled={page === 0}
            onClick={() => setPage(page - 1)}
          >
            <ChevronLeft className="ic" aria-hidden="true" />
          </Button>
          <span className="muted">
            {fill(t("schedules.runs.page"), { page: String(page + 1), pages: String(pages) })}
          </span>
          <Button
            variant="ghost"
            size="icon"
            aria-label={t("schedules.runs.next")}
            disabled={page >= pages - 1}
            onClick={() => setPage(page + 1)}
          >
            <ChevronRight className="ic" aria-hidden="true" />
          </Button>
        </div>
      ) : null}
    </div>
  )
}
