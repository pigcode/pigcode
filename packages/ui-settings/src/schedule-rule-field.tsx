/**
 * 定时任务的「计划」：一个输入框样子的计划框，里面是几个小胶囊——频率（每天、每工作日、每周、每月、每小时、
 * 自定义），这种频率要选的星期或几号，几点几分，最后是本机时区。下面预览下一次运行。
 * 自定义重复在 schedule-custom-repeat.tsx 的对话框里填。
 */
import { useState } from "react"
import { Pencil } from "lucide-react"
import type { ScheduleRule } from "@pigcode/contracts"
import { useLocale } from "@pigcode/ui-primitives"
import { ChoiceSelect, MultiPill } from "./choice-select"
import { CustomRepeatDialog } from "./schedule-custom-repeat"
import { WEEK_ORDER, dayList, fill, formatEndsAt, formatRule, weekdayName } from "./schedule-format"
import {
  MONTH_DAYS,
  MinutePill,
  PROBLEM_KEYS,
  Preview,
  TimePills,
  TimeZone,
  minuteOf,
  timeOf,
  toggled,
  weekDaysOf,
  type Problem,
  type RuleValue,
} from "./schedule-rule-parts"

export type { RuleValue } from "./schedule-rule-parts"

type Frequency = "hourly" | "daily" | "weekdays" | "weekly" | "monthly" | "custom"

const FREQUENCIES: readonly Frequency[] = [
  "daily",
  "weekdays",
  "weekly",
  "monthly",
  "hourly",
  "custom",
]

function frequencyOf(rule: ScheduleRule): Frequency {
  switch (rule.kind) {
    case "hourly":
    case "daily":
    case "weekdays":
    case "weekly":
    case "monthly":
      return rule.kind
    default:
      return "custom"
  }
}

/** 常用频率在计划框里选的东西。 */
interface StandardFields {
  frequency: Frequency
  time: string
  minute: number
  days: ReadonlySet<number>
  monthDay: number
}

/** 常用频率拼成规则；每周一天都没选时给出原因。 */
function standardRuleOf(fields: StandardFields): ScheduleRule | { problem: Problem } {
  const { time } = fields
  switch (fields.frequency) {
    case "hourly":
      return { kind: "hourly", minute: fields.minute }
    case "weekly":
      return fields.days.size === 0
        ? { problem: "days" }
        : { kind: "weekly", days: [...fields.days].sort(), time }
    case "monthly":
      return { kind: "monthly", day: fields.monthDay, time }
    case "weekdays":
      return { kind: "weekdays", time }
    default:
      return { kind: "daily", time }
  }
}

/**
 * 「计划」字段。value 是最近一次选对的计划；onChange 在选对时给出新的计划，每周一天都没选时给 null。
 * pinned 是编辑时原来排好的下一次：规则没改时预览显示它。
 */
export function ScheduleRuleField({
  value,
  pinned,
  disabled,
  onChange,
}: {
  value: RuleValue
  pinned?: string | null | undefined
  disabled?: boolean | undefined
  onChange: (value: RuleValue | null) => void
}) {
  const { t, locale } = useLocale()
  const [fields, setFields] = useState<StandardFields>(() => ({
    frequency: frequencyOf(value.rule),
    time: timeOf(value.rule),
    minute: minuteOf(value.rule),
    days: new Set(weekDaysOf(value.rule)),
    monthDay: value.rule.kind === "monthly" ? value.rule.day : new Date().getDate(),
  }))
  const [problem, setProblem] = useState<Problem | null>(null)
  const [customOpen, setCustomOpen] = useState(false)

  /** 改了频率或某个胶囊：拼出规则交上去，自定义重复由对话框负责。 */
  function update(patch: Partial<StandardFields>): void {
    const next = { ...fields, ...patch }
    setFields(next)
    if (next.frequency === "custom") return
    const built = standardRuleOf(next)
    if ("problem" in built) {
      setProblem(built.problem)
      onChange(null)
    } else {
      setProblem(null)
      onChange({ rule: built, endsAt: null })
    }
  }

  const { frequency } = fields
  const weekOptions = WEEK_ORDER.map((day) => ({
    value: day,
    label: weekdayName(day, locale, "long"),
  }))
  return (
    <div className="schedule-rule">
      <div className="schedule-box" data-disabled={disabled ? "" : undefined}>
        <ChoiceSelect<Frequency>
          variant="pill"
          label={t("schedules.frequency")}
          value={frequency}
          disabled={disabled}
          options={FREQUENCIES.map((value) => ({ value, label: t(`schedules.freq.${value}`) }))}
          onChange={(next) => {
            if (next === "custom") setCustomOpen(true)
            else update({ frequency: next })
          }}
        />
        {frequency === "weekly" ? (
          <MultiPill
            label={t("schedules.days")}
            summary={
              fields.days.size > 0 ? dayList([...fields.days], t, locale) : t("schedules.days")
            }
            options={weekOptions}
            selected={fields.days}
            disabled={disabled}
            onToggle={(day) => update({ days: toggled(fields.days, day) })}
          />
        ) : null}
        {frequency === "monthly" ? (
          <ChoiceSelect
            variant="pill"
            label={t("schedules.monthDay")}
            value={String(fields.monthDay)}
            disabled={disabled}
            options={MONTH_DAYS.map((day) => ({
              value: String(day),
              label: fill(t("schedules.monthDayOption"), { day: String(day) }),
            }))}
            onChange={(day) => update({ monthDay: Number(day) })}
          />
        ) : null}
        {frequency === "hourly" ? (
          <MinutePill
            minute={fields.minute}
            disabled={disabled}
            onChange={(minute) => update({ minute })}
          />
        ) : null}
        {frequency !== "hourly" && frequency !== "custom" ? (
          <TimePills time={fields.time} disabled={disabled} onChange={(time) => update({ time })} />
        ) : null}
        {frequency === "custom" ? (
          <button
            type="button"
            className="pill-select schedule-custom-summary"
            aria-label={t("schedules.custom.edit")}
            disabled={disabled}
            onClick={() => setCustomOpen(true)}
          >
            <span className="truncate">
              {formatRule(value.rule, t, locale)}
              {value.endsAt ? ` · ${formatEndsAt(value.endsAt, t, locale)}` : null}
            </span>
            <Pencil className="ic ic-sm" aria-hidden="true" />
          </button>
        ) : null}
        {value.rule.kind === "everyMinutes" ? null : <TimeZone />}
      </div>
      {problem ? (
        <p className="error-text">{t(PROBLEM_KEYS[problem])}</p>
      ) : (
        <Preview value={value} pinned={pinned} />
      )}
      <CustomRepeatDialog
        open={customOpen}
        initial={value}
        onCancel={() => setCustomOpen(false)}
        onConfirm={(next) => {
          setCustomOpen(false)
          setProblem(null)
          setFields((current) => ({ ...current, frequency: "custom" }))
          onChange(next)
        }}
      />
    </div>
  )
}
