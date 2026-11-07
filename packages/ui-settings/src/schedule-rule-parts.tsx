/** 计划框与自定义重复共用的部分：几点几分的胶囊、时区、下一次运行的预览，以及规则字段的取值。 */
import { nextScheduleRunBefore, type ScheduleRule } from "@pigcode/contracts"
import { useLocale } from "@pigcode/ui-primitives"
import { ChoiceSelect } from "./choice-select"
import { fill, formatWhen } from "./schedule-format"

/** 计划：规则与结束日期。 */
export interface RuleValue {
  rule: ScheduleRule
  endsAt: string | null
}

/** 填得不对的原因：每周一天都没选、间隔不在范围里、没选结束日期。 */
export type Problem = "days" | "every" | "endDate"

export const PROBLEM_KEYS = {
  days: "schedules.daysRequired",
  every: "schedules.everyInvalid",
  endDate: "schedules.endDateInvalid",
} as const

export const MONTH_DAYS = Array.from({ length: 31 }, (_, index) => index + 1)
export const pad = (number: number) => String(number).padStart(2, "0")
const HOURS = Array.from({ length: 24 }, (_, hour) => ({ value: pad(hour), label: pad(hour) }))
const MINUTES = Array.from({ length: 60 }, (_, minute) => ({
  value: pad(minute),
  label: pad(minute),
}))

export const timeOf = (rule: ScheduleRule): string => ("time" in rule ? rule.time : "09:00")
export const minuteOf = (rule: ScheduleRule): number => ("minute" in rule ? rule.minute : 0)
export const weekDaysOf = (rule: ScheduleRule): number[] =>
  rule.kind === "weekly" || rule.kind === "everyWeeks" ? rule.days : [new Date().getDay()]

/** 本机时区，例如「GMT+08:00」；计划都按这个时区算。 */
function timeZoneLabel(): string {
  const offset = -new Date().getTimezoneOffset()
  const sign = offset >= 0 ? "+" : "-"
  const minutes = Math.abs(offset)
  return `GMT${sign}${pad(Math.floor(minutes / 60))}:${pad(minutes % 60)}`
}

/** 本地日期的 `YYYY-MM-DD`，给 date 输入框用。 */
export function dateInput(value: Date): string {
  return `${value.getFullYear()}-${pad(value.getMonth() + 1)}-${pad(value.getDate())}`
}

/** date 输入框的那一天结束的时刻（本地 23:59:59.999）；不合法时为 null。 */
export function endOfDay(text: string): string | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text)
  if (!match) return null
  const [, year, month, day] = match
  return new Date(Number(year), Number(month) - 1, Number(day), 23, 59, 59, 999).toISOString()
}

export const toggled = (set: ReadonlySet<number>, value: number): Set<number> => {
  const next = new Set(set)
  if (next.has(value)) next.delete(value)
  else next.add(value)
  return next
}

/** 几点、几分两个胶囊；时间总是合法的「HH:MM」。 */
export function TimePills({
  time,
  disabled,
  onChange,
}: {
  time: string
  disabled?: boolean | undefined
  onChange: (time: string) => void
}) {
  const { t } = useLocale()
  const [hour = "09", minute = "00"] = time.split(":")
  return (
    <span className="schedule-time-pills">
      <ChoiceSelect
        variant="pill"
        label={t("schedules.hour")}
        value={hour}
        options={HOURS}
        disabled={disabled}
        onChange={(next) => onChange(`${next}:${minute}`)}
      />
      <span className="schedule-colon" aria-hidden="true">
        :
      </span>
      <ChoiceSelect
        variant="pill"
        label={t("schedules.minute")}
        value={minute}
        options={MINUTES}
        disabled={disabled}
        onChange={(next) => onChange(`${hour}:${next}`)}
      />
    </span>
  )
}

/** 每小时的第几分。 */
export function MinutePill({
  minute,
  disabled,
  onChange,
}: {
  minute: number
  disabled?: boolean | undefined
  onChange: (minute: number) => void
}) {
  const { t } = useLocale()
  return (
    <span className="schedule-time-pills">
      <span className="schedule-word">{t("schedules.minutePrefix")}</span>
      <ChoiceSelect
        variant="pill"
        label={t("schedules.minute")}
        value={pad(minute)}
        options={MINUTES}
        disabled={disabled}
        onChange={(next) => onChange(Number(next))}
      />
      <span className="schedule-word">{t("schedules.minuteSuffix")}</span>
    </span>
  )
}

export function TimeZone() {
  return <span className="schedule-tz">{timeZoneLabel()}</span>
}

/** 下一次运行的预览：「下次运行：明天 09:00。」或者不会再运行。 */
export function Preview({
  value,
  pinned,
}: {
  value: RuleValue
  pinned?: string | null | undefined
}) {
  const { t, locale } = useLocale()
  const now = Date.now()
  const next =
    pinned !== undefined
      ? pinned
      : (nextScheduleRunBefore(value.rule, new Date(now), value.endsAt)?.toISOString() ?? null)
  return (
    <p className="hint schedule-preview" aria-live="polite">
      {next
        ? fill(t("schedules.preview"), { time: formatWhen(next, locale, now) })
        : t("schedules.previewNone")}
    </p>
  )
}
