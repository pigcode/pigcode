/** 定时任务列表中的单条任务卡片组件。 */
import { useState } from "react"
import {
  CircleCheck,
  Clock,
  Ellipsis,
  Pause,
  Pencil,
  Play,
  Trash2,
  type LucideIcon,
} from "lucide-react"
import type { HostSummary, Schedule, ScheduleStatus } from "@pigcode/contracts"
import { HostBadge, Menu, useLocale } from "@pigcode/ui-primitives"
import { STATUS_KEYS, fill, formatRule, formatWhen } from "./schedule-format"

const STATUS_ICONS: Record<ScheduleStatus, LucideIcon> = {
  active: Clock,
  paused: Pause,
  completed: CircleCheck,
}

/** 读屏与菜单里用的任务名：标题，没有标题时是指令的第一行。 */
export function taskName(schedule: Schedule, untitled: string): string {
  if (schedule.title) return schedule.title
  const line = schedule.prompt.trim().split(/\r?\n/)[0] ?? ""
  return line ? (line.length > 40 ? `${line.slice(0, 40)}…` : line) : untitled
}

export function ScheduleCard({
  schedule,
  host,
  showHost = false,
  now,
  onEdit,
  onToggle,
  onRunNow,
  onDelete,
}: {
  schedule: Schedule
  host?: HostSummary | undefined
  showHost?: boolean | undefined
  now: number
  onEdit: () => void
  onToggle: () => void
  onRunNow: () => void
  onDelete: () => void
}) {
  const { t, locale } = useLocale()
  const [menuOpen, setMenuOpen] = useState(false)
  const name = taskName(schedule, t("schedules.untitled"))
  const offline = Boolean(host && host.status !== "connected")
  const { status } = schedule
  const StatusIcon = STATUS_ICONS[status]
  const rule = formatRule(schedule.rule, t, locale)
  // 暂停与完成后不再往下排，只说计划本身；运行中的任务接着说下一次。
  const when =
    status === "active" && schedule.nextRunAt
      ? `${rule} · ${fill(t("schedules.nextRun"), { when: formatWhen(schedule.nextRunAt, locale, now) })}`
      : rule
  return (
    <article
      className="schedule-card"
      data-schedule={schedule.id}
      data-status={status}
      data-offline={offline ? "" : undefined}
      data-menu-open={menuOpen ? "" : undefined}
    >
      <button type="button" className="schedule-card-main" onClick={onEdit}>
        <span className="schedule-card-title truncate">
          {schedule.title || t("schedules.untitled")}
        </span>
      </button>
      <p className="schedule-card-prompt">{schedule.prompt}</p>
      <div className="schedule-card-foot">
        {showHost && host ? <HostBadge host={host} showOffline={offline} /> : null}
        {status === "active" ? null : (
          <span className="schedule-card-state">
            <StatusIcon className="ic ic-sm" aria-hidden="true" />
            {t(STATUS_KEYS[status])}
          </span>
        )}
        <span
          className="schedule-card-when"
          data-dim={status === "active" ? undefined : ""}
          title={when}
        >
          <Clock className="ic ic-sm" aria-hidden="true" />
          <span className="truncate">{when}</span>
        </span>
        <span className="schedule-card-count">
          {fill(t("schedules.runCount"), { count: String(schedule.runCount) })}
        </span>
      </div>
      <Menu.Root open={menuOpen} onOpenChange={setMenuOpen}>
        <Menu.Trigger
          className="icon-btn schedule-card-menu"
          aria-label={fill(t("schedules.more"), { task: name })}
          title={fill(t("schedules.more"), { task: name })}
        >
          <Ellipsis className="ic ic-sm" aria-hidden="true" />
        </Menu.Trigger>
        <Menu.Portal>
          <Menu.Positioner side="bottom" align="end" sideOffset={4}>
            <Menu.Popup className="schedule-menu">
              <Menu.Item disabled={offline} onClick={onRunNow}>
                <Play className="ic ic-sm" aria-hidden="true" />
                {t("settings.schedules.runNow")}
              </Menu.Item>
              <Menu.Item onClick={onEdit}>
                <Pencil className="ic ic-sm" aria-hidden="true" />
                {t("schedules.edit")}
              </Menu.Item>
              {status === "completed" ? null : (
                <Menu.Item disabled={offline} onClick={onToggle}>
                  {schedule.enabled ? (
                    <Pause className="ic ic-sm" aria-hidden="true" />
                  ) : (
                    <Play className="ic ic-sm" aria-hidden="true" />
                  )}
                  {schedule.enabled ? t("schedules.pause") : t("schedules.resume")}
                </Menu.Item>
              )}
              <Menu.Separator />
              <Menu.Item data-danger="" disabled={offline} onClick={onDelete}>
                <Trash2 className="ic ic-sm" aria-hidden="true" />
                {t("settings.schedules.delete")}
              </Menu.Item>
            </Menu.Popup>
          </Menu.Positioner>
        </Menu.Portal>
      </Menu.Root>
    </article>
  )
}
