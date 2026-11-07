/**
 * 定时任务的规则与时间怎么说：「每工作日 09:00」「每 2 周的周一、周四，10:00」、「下次运行 明天 09:00」，
 * 以及新建时的默认规则与模板。
 */
import type { ScheduleRule, ScheduleRunStatus, ScheduleStatus } from "@pigcode/contracts"
import { formatDuration, type Locale, type MessageKey } from "@pigcode/ui-primitives"

type Translate = (key: MessageKey) => string

/** 新建任务时默认的规则：每天上午九点。 */
export const DEFAULT_RULE: ScheduleRule = { kind: "daily", time: "09:00" }

/** 星期几在界面上的顺序：周一在前，周日在最后；值与 Date.getDay() 一致。 */
export const WEEK_ORDER: readonly number[] = [1, 2, 3, 4, 5, 6, 0]

/** 一次替换模板里的全部 {name}：任务内容里的 $ 与花括号原样显示，不会被当成替换模式。 */
export function fill(template: string, values: Readonly<Record<string, string>>): string {
  return template.replace(/\{(\w+)\}/g, (match, name: string) =>
    Object.hasOwn(values, name) ? (values[name] ?? match) : match,
  )
}

/** 星期几的名字：short 是「周三」「Wed」，long 是「星期三」「Wednesday」。2026-11-01 是周日。 */
export function weekdayName(day: number, locale: Locale, width: "short" | "long"): string {
  return new Intl.DateTimeFormat(locale, { weekday: width }).format(new Date(2026, 10, 1 + day))
}

/** 月份的名字：「11月」「Nov」。 */
export function monthName(month: number, locale: Locale): string {
  return new Intl.DateTimeFormat(locale, { month: "short" }).format(new Date(2026, month - 1, 1))
}

/** 几天按周一在前的顺序连起来：「周一、周四」。 */
export function dayList(days: readonly number[], t: Translate, locale: Locale): string {
  return WEEK_ORDER.filter((day) => days.includes(day))
    .map((day) => weekdayName(day, locale, "short"))
    .join(t("schedules.listSeparator"))
}

const pad = (value: number) => String(value).padStart(2, "0")

/** 把规则说成一句话。 */
export function formatRule(rule: ScheduleRule, t: Translate, locale: Locale): string {
  const every = "every" in rule ? String(rule.every) : ""
  switch (rule.kind) {
    case "hourly":
      return fill(t("schedules.rule.hourly"), { minute: pad(rule.minute) })
    case "daily":
      return fill(t("schedules.rule.daily"), { time: rule.time })
    case "weekdays":
      return fill(t("schedules.rule.weekdays"), { time: rule.time })
    case "weekly":
      return fill(t("schedules.rule.weekly"), {
        days: dayList(rule.days, t, locale),
        time: rule.time,
      })
    case "monthly":
      return fill(t("schedules.rule.monthly"), { day: String(rule.day), time: rule.time })
    case "everyMinutes":
      return fill(t("schedules.rule.everyMinutes"), { every })
    case "everyHours":
      return fill(t("schedules.rule.everyHours"), { every, minute: pad(rule.minute) })
    case "everyDays":
      return fill(t("schedules.rule.everyDays"), { every, time: rule.time })
    case "everyWeeks":
      return fill(t("schedules.rule.everyWeeks"), {
        every,
        days: dayList(rule.days, t, locale),
        time: rule.time,
      })
    case "everyMonths":
      return fill(t("schedules.rule.everyMonths"), {
        every,
        days: [...rule.days].sort((left, right) => left - right).join(t("schedules.listSeparator")),
        time: rule.time,
      })
    case "everyMonthsWeekday":
      return fill(t("schedules.rule.everyMonthsWeekday"), {
        every,
        day: weekdayName(rule.weekday, locale, "short"),
        time: rule.time,
      })
    case "everyYears":
      return fill(t("schedules.rule.everyYears"), {
        every,
        month: monthName(rule.month, locale),
        day: String(rule.day),
        time: rule.time,
      })
  }
}

/** 结束日期：「至 2026年12月31日」。 */
export function formatEndsAt(endsAt: string, t: Translate, locale: Locale): string {
  const date = new Intl.DateTimeFormat(locale, { dateStyle: "medium" }).format(new Date(endsAt))
  return fill(t("schedules.endsOn"), { date })
}

/** 下一次或某一次运行的时刻：「明天 09:00」「11月20日周五 09:00」「今天 14:15」。 */
export function formatWhen(value: string | Date, locale: Locale, now: number): string {
  const date = typeof value === "string" ? new Date(value) : value
  const time = new Intl.DateTimeFormat(locale, { hour: "2-digit", minute: "2-digit" }).format(date)
  const today = new Date(now)
  const days = Math.round(
    (Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()) -
      Date.UTC(today.getFullYear(), today.getMonth(), today.getDate())) /
      86_400_000,
  )
  if (days >= -1 && days <= 1) {
    const word = new Intl.RelativeTimeFormat(locale, { numeric: "auto" }).format(days, "day")
    return `${word} ${time}`
  }
  const sameYear = date.getFullYear() === today.getFullYear()
  const day = new Intl.DateTimeFormat(locale, {
    ...(sameYear ? {} : { year: "numeric" }),
    month: "short",
    day: "numeric",
    weekday: "short",
  }).format(date)
  return `${day} ${time}`
}

/** 一次运行用了多久；还没结束或时间不合法时为 null。 */
export function formatRunDuration(
  triggeredAt: string,
  finishedAt: string | null,
  locale: Locale,
): string | null {
  if (finishedAt === null) return null
  const ms = Date.parse(finishedAt) - Date.parse(triggeredAt)
  return Number.isFinite(ms) && ms >= 0 ? formatDuration(ms, locale) : null
}

export const STATUS_KEYS: Record<ScheduleStatus, MessageKey> = {
  active: "schedules.status.active",
  paused: "schedules.status.paused",
  completed: "schedules.status.completed",
}

export const RUN_STATUS_KEYS: Record<ScheduleRunStatus, MessageKey> = {
  running: "schedules.runs.status.running",
  succeeded: "schedules.runs.status.succeeded",
  failed: "schedules.runs.status.failed",
  stopped: "schedules.runs.status.stopped",
  skipped: "schedules.runs.status.skipped",
}

/** 跳过或失败的原因：Host 给的错误码换成文案，其他的错误信息原样显示。 */
export function runReason(error: string | null, t: Translate): string | null {
  if (error === "THREAD_BUSY") return t("schedules.runs.reason.busy")
  if (error === "AGENT_UNAVAILABLE") return t("schedules.runs.reason.unavailable")
  return error
}

/** 一个模板：标题、任务内容与规则；点开后预填到新建页里，用户再选会话。 */
export interface ScheduleTemplate {
  id: "standup" | "risk" | "release" | "docs"
  title: MessageKey
  prompt: MessageKey
  rule: ScheduleRule
}

export const SCHEDULE_TEMPLATES: readonly ScheduleTemplate[] = [
  {
    id: "standup",
    title: "schedules.template.standup",
    prompt: "schedules.template.standup.prompt",
    rule: { kind: "weekdays", time: "09:00" },
  },
  {
    id: "risk",
    title: "schedules.template.risk",
    prompt: "schedules.template.risk.prompt",
    rule: { kind: "daily", time: "10:00" },
  },
  {
    id: "release",
    title: "schedules.template.release",
    prompt: "schedules.template.release.prompt",
    rule: { kind: "weekly", days: [5], time: "16:00" },
  },
  {
    id: "docs",
    title: "schedules.template.docs",
    prompt: "schedules.template.docs.prompt",
    rule: { kind: "weekly", days: [3], time: "15:00" },
  },
]
