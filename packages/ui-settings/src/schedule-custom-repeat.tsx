/**
 * 自定义重复对话框：每 N 分钟 / 小时 / 天 / 周 / 个月 / 年，按周时选星期几，按月时按日期或按星期，
 * 按年时选几月几号，可以设结束日期。确定时交出计划，取消时什么都不改。
 */
import { useEffect, useState } from "react"
import type { ScheduleRule } from "@pigcode/contracts"
import { Button, Dialog, Input, SegmentedControl, useLocale } from "@pigcode/ui-primitives"
import { ChoiceSelect, TogglePills } from "./choice-select"
import { WEEK_ORDER, fill, monthName, weekdayName } from "./schedule-format"
import {
  MONTH_DAYS,
  MinutePill,
  PROBLEM_KEYS,
  Preview,
  TimePills,
  TimeZone,
  dateInput,
  endOfDay,
  minuteOf,
  timeOf,
  toggled,
  weekDaysOf,
  type Problem,
  type RuleValue,
} from "./schedule-rule-parts"

type Unit = "minute" | "hour" | "day" | "week" | "month" | "year"
const UNITS: readonly Unit[] = ["minute", "hour", "day", "week", "month", "year"]

/** 自定义重复对话框里的各个字段。 */
interface CustomFields {
  unit: Unit
  every: string
  minute: number
  time: string
  days: ReadonlySet<number>
  monthMode: "date" | "weekday"
  monthDates: ReadonlySet<number>
  monthWeekday: number
  yearMonth: number
  yearDay: number
  endsMode: "never" | "on"
  endDate: string
  anchor: string
}

/** 从任意规则推出自定义重复的初始字段：常用频率对应「每 1 个单位」。 */
function customFieldsOf(rule: ScheduleRule, endsAt: string | null): CustomFields {
  const now = new Date()
  const unit: Unit =
    rule.kind === "everyMinutes"
      ? "minute"
      : rule.kind === "hourly" || rule.kind === "everyHours"
        ? "hour"
        : rule.kind === "daily" || rule.kind === "everyDays"
          ? "day"
          : rule.kind === "weekdays" || rule.kind === "weekly" || rule.kind === "everyWeeks"
            ? "week"
            : rule.kind === "everyYears"
              ? "year"
              : "month"
  return {
    unit,
    every: String("every" in rule ? rule.every : 1),
    minute: minuteOf(rule),
    time: timeOf(rule),
    days: new Set(rule.kind === "weekdays" ? [1, 2, 3, 4, 5] : weekDaysOf(rule)),
    monthMode: rule.kind === "everyMonthsWeekday" ? "weekday" : "date",
    monthDates: new Set(
      rule.kind === "everyMonths"
        ? rule.days
        : rule.kind === "monthly"
          ? [rule.day]
          : [now.getDate()],
    ),
    monthWeekday: rule.kind === "everyMonthsWeekday" ? rule.weekday : now.getDay(),
    yearMonth: rule.kind === "everyYears" ? rule.month : now.getMonth() + 1,
    yearDay: rule.kind === "everyYears" ? rule.day : now.getDate(),
    endsMode: endsAt ? "on" : "never",
    endDate: dateInput(endsAt ? new Date(endsAt) : new Date(now.getTime() + 30 * 86_400_000)),
    anchor: "anchor" in rule ? rule.anchor : now.toISOString(),
  }
}

/** 自定义字段拼成计划；填得不对时给出原因。 */
function customValueOf(fields: CustomFields): RuleValue | { problem: Problem } {
  const every = Number(fields.every)
  if (!Number.isInteger(every) || every < 1 || every > 200) return { problem: "every" }
  const { anchor, time, minute } = fields
  let rule: ScheduleRule
  switch (fields.unit) {
    case "minute":
      rule = { kind: "everyMinutes", every, anchor }
      break
    case "hour":
      rule = { kind: "everyHours", every, minute, anchor }
      break
    case "day":
      rule = { kind: "everyDays", every, time, anchor }
      break
    case "week":
      if (fields.days.size === 0) return { problem: "days" }
      rule = { kind: "everyWeeks", every, days: [...fields.days].sort(), time, anchor }
      break
    case "month":
      if (fields.monthMode === "weekday") {
        rule = { kind: "everyMonthsWeekday", every, weekday: fields.monthWeekday, time, anchor }
        break
      }
      if (fields.monthDates.size === 0) return { problem: "days" }
      rule = {
        kind: "everyMonths",
        every,
        days: [...fields.monthDates].sort((left, right) => left - right),
        time,
        anchor,
      }
      break
    case "year":
      rule = {
        kind: "everyYears",
        every,
        month: fields.yearMonth,
        day: fields.yearDay,
        time,
        anchor,
      }
      break
  }
  if (fields.endsMode === "never") return { rule, endsAt: null }
  const endsAt = endOfDay(fields.endDate)
  return endsAt ? { rule, endsAt } : { problem: "endDate" }
}

export function CustomRepeatDialog({
  open,
  initial,
  onConfirm,
  onCancel,
}: {
  open: boolean
  initial: RuleValue
  onConfirm: (value: RuleValue) => void
  onCancel: () => void
}) {
  const { t, locale } = useLocale()
  const [fields, setFields] = useState(() => customFieldsOf(initial.rule, initial.endsAt))
  // 每次打开都从当前的计划重新开始。
  useEffect(() => {
    if (open) setFields(customFieldsOf(initial.rule, initial.endsAt))
  }, [open, initial])
  const update = (patch: Partial<CustomFields>) =>
    setFields((current) => ({ ...current, ...patch }))
  const built = customValueOf(fields)
  const timed = fields.unit !== "minute" && fields.unit !== "hour"

  return (
    <Dialog.Root
      open={open}
      onOpenChange={(next) => {
        if (!next) onCancel()
      }}
    >
      <Dialog.Content
        className="schedule-custom-dialog"
        title={t("schedules.custom.title")}
        closeLabel={t("common.close")}
      >
        <form
          onSubmit={(event) => {
            event.preventDefault()
            // 对话框画在 portal 里，React 的提交事件仍会冒泡到编辑页的表单，让它跟着保存。
            event.stopPropagation()
            if (!("problem" in built)) onConfirm(built)
          }}
        >
          <Dialog.Body>
            <div className="field">
              <span className="label">{t("schedules.custom.frequency")}</span>
              <div className="schedule-row">
                <span className="schedule-word">{t("schedules.custom.every")}</span>
                <Input
                  className="schedule-number"
                  type="number"
                  min={1}
                  max={200}
                  step={1}
                  aria-label={t("schedules.custom.count")}
                  value={fields.every}
                  onChange={(event) => update({ every: event.target.value })}
                />
                <ChoiceSelect
                  className="schedule-unit"
                  label={t("schedules.custom.unit")}
                  value={fields.unit}
                  options={UNITS.map((unit) => ({
                    value: unit,
                    label: t(`schedules.custom.unit.${unit}`),
                  }))}
                  onChange={(unit) => update({ unit })}
                />
              </div>
            </div>
            {fields.unit === "week" ? (
              <div className="field">
                <span className="label">{t("schedules.days")}</span>
                <TogglePills
                  label={t("schedules.days")}
                  selected={fields.days}
                  options={WEEK_ORDER.map((day) => ({
                    value: day,
                    label: weekdayName(day, locale, "short"),
                    name: weekdayName(day, locale, "long"),
                  }))}
                  onToggle={(day) => update({ days: toggled(fields.days, day) })}
                />
              </div>
            ) : null}
            {fields.unit === "month" ? (
              <div className="field">
                <span className="label">{t("schedules.custom.rule")}</span>
                <SegmentedControl<"date" | "weekday">
                  className="schedule-seg"
                  aria-label={t("schedules.custom.rule")}
                  value={fields.monthMode}
                  onValueChange={(monthMode) => update({ monthMode })}
                  options={[
                    { value: "date", label: t("schedules.custom.byDate") },
                    { value: "weekday", label: t("schedules.custom.byWeekday") },
                  ]}
                />
                {fields.monthMode === "date" ? (
                  <TogglePills
                    className="schedule-month-dates"
                    label={t("schedules.custom.dates")}
                    selected={fields.monthDates}
                    options={MONTH_DAYS.map((day) => ({ value: day, label: String(day) }))}
                    onToggle={(day) => update({ monthDates: toggled(fields.monthDates, day) })}
                  />
                ) : (
                  <div className="schedule-box">
                    <span className="schedule-word">{t("schedules.custom.firstWeekday")}</span>
                    <ChoiceSelect
                      variant="pill"
                      label={t("schedules.custom.weekday")}
                      value={String(fields.monthWeekday)}
                      options={WEEK_ORDER.map((day) => ({
                        value: String(day),
                        label: weekdayName(day, locale, "long"),
                      }))}
                      onChange={(day) => update({ monthWeekday: Number(day) })}
                    />
                  </div>
                )}
              </div>
            ) : null}
            {fields.unit === "year" ? (
              <div className="field">
                <span className="label">{t("schedules.custom.day")}</span>
                <div className="schedule-box">
                  <ChoiceSelect
                    variant="pill"
                    label={t("schedules.custom.month")}
                    value={String(fields.yearMonth)}
                    options={Array.from({ length: 12 }, (_, index) => ({
                      value: String(index + 1),
                      label: monthName(index + 1, locale),
                    }))}
                    onChange={(month) => update({ yearMonth: Number(month) })}
                  />
                  <ChoiceSelect
                    variant="pill"
                    label={t("schedules.custom.day")}
                    value={String(fields.yearDay)}
                    options={MONTH_DAYS.map((day) => ({
                      value: String(day),
                      label: fill(t("schedules.monthDayOption"), { day: String(day) }),
                    }))}
                    onChange={(day) => update({ yearDay: Number(day) })}
                  />
                </div>
              </div>
            ) : null}
            {fields.unit === "hour" ? (
              <div className="field">
                <span className="label">{t("schedules.time")}</span>
                <div className="schedule-box">
                  <MinutePill minute={fields.minute} onChange={(minute) => update({ minute })} />
                </div>
              </div>
            ) : null}
            {timed ? (
              <div className="field">
                <span className="label">{t("schedules.time")}</span>
                <div className="schedule-box">
                  <TimePills time={fields.time} onChange={(time) => update({ time })} />
                  <TimeZone />
                </div>
              </div>
            ) : null}
            <div className="field">
              <span className="label">{t("schedules.custom.ends")}</span>
              <div className="schedule-row">
                <SegmentedControl<"never" | "on">
                  className="schedule-seg"
                  aria-label={t("schedules.custom.ends")}
                  value={fields.endsMode}
                  onValueChange={(endsMode) => update({ endsMode })}
                  options={[
                    { value: "never", label: t("schedules.custom.never") },
                    { value: "on", label: t("schedules.custom.on") },
                  ]}
                />
                {fields.endsMode === "on" ? (
                  <Input
                    className="schedule-date"
                    type="date"
                    aria-label={t("schedules.custom.endDate")}
                    value={fields.endDate}
                    onChange={(event) => update({ endDate: event.target.value })}
                  />
                ) : null}
              </div>
            </div>
            {"problem" in built ? (
              <p className="error-text">{t(PROBLEM_KEYS[built.problem])}</p>
            ) : (
              <Preview value={built} />
            )}
          </Dialog.Body>
          <Dialog.Footer>
            <Dialog.Close render={<Button type="button" variant="ghost" />}>
              {t("schedules.cancel")}
            </Dialog.Close>
            <Button type="submit" variant="primary" disabled={"problem" in built}>
              {t("schedules.custom.confirm")}
            </Button>
          </Dialog.Footer>
        </form>
      </Dialog.Content>
    </Dialog.Root>
  )
}
