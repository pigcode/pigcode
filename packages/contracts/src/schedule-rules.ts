/**
 * 定时任务规则的下一次运行时间。Host 排期和界面预览用同一份算法：日历规则按运行它的机器的本地时间算，
 * 跨夏令时的那天由 Date 自己处理（不存在的时刻顺延）。每 N 天、周、月、年按 anchor 对齐周期。
 */
import type { ScheduleRule } from "./domain"

/** 「HH:MM」拆成小时和分钟。 */
function clock(time: string): { hours: number; minutes: number } {
  const [hours = "0", minutes = "0"] = time.split(":")
  return { hours: Number(hours), minutes: Number(minutes) }
}

/** 非负余数。 */
function mod(value: number, size: number): number {
  return ((value % size) + size) % size
}

/** 本地日期的天序号：用 UTC 算同一个年月日，跨夏令时也不会差一天。 */
function dayNumber(date: Date): number {
  return Math.floor(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()) / 86_400_000)
}

/** 本地日期所在那一周（周一开始）的序号。 */
function weekNumber(date: Date): number {
  const monday = dayNumber(date) - mod(date.getDay() - 1, 7)
  return Math.floor(monday / 7)
}

/** 本地日期的月序号。 */
function monthNumber(date: Date): number {
  return date.getFullYear() * 12 + date.getMonth()
}

function daysInMonth(year: number, month: number): number {
  return new Date(year, month + 1, 0).getDate()
}

/** from 那天往后数 dayOffset 天的本地时刻。 */
function onDay(from: Date, dayOffset: number, time: string): Date {
  const { hours, minutes } = clock(time)
  return new Date(from.getFullYear(), from.getMonth(), from.getDate() + dayOffset, hours, minutes)
}

/** 月序号对应那个月的第 day 号（没有这一天时落在月末）的本地时刻。 */
function onMonthDay(month: number, day: number, time: string): Date {
  const { hours, minutes } = clock(time)
  const year = Math.floor(month / 12)
  const index = mod(month, 12)
  return new Date(year, index, Math.min(day, daysInMonth(year, index)), hours, minutes)
}

/** 从 from 起逐天往后找（不含 from），第一个满足 accept 的那天的时刻；最多看 limit 天。 */
function nextDay(from: Date, time: string, limit: number, accept: (day: Date) => boolean): Date {
  for (let offset = 0; offset <= limit; offset += 1) {
    const candidate = onDay(from, offset, time)
    if (candidate.getTime() > from.getTime() && accept(candidate)) return candidate
  }
  // 规则合法时一定能在范围内找到；走到这里说明规则本身不合法。
  throw new Error("schedule rule has no time to run")
}

/** 从 from 所在的月起逐月往后找，第一个满足条件的时刻；最多看 limit 个月。 */
function nextMonth(
  from: Date,
  limit: number,
  candidates: (month: number) => readonly Date[],
): Date {
  const start = monthNumber(from)
  for (let offset = 0; offset <= limit; offset += 1) {
    const found = candidates(start + offset)
      .filter((candidate) => candidate.getTime() > from.getTime())
      .sort((left, right) => left.getTime() - right.getTime())[0]
    if (found) return found
  }
  throw new Error("schedule rule has no time to run")
}

/** 从 anchor 起每 step 毫秒一次，from 之后的第一次。 */
function nextStep(anchor: number, step: number, from: Date): Date {
  if (anchor > from.getTime()) return new Date(anchor)
  return new Date(anchor + (Math.floor((from.getTime() - anchor) / step) + 1) * step)
}

const WEEKDAYS = new Set([1, 2, 3, 4, 5])

/** 规则在 from 之后（不含 from）的下一次运行时间。 */
export function nextScheduleRun(rule: ScheduleRule, from: Date): Date {
  switch (rule.kind) {
    case "hourly": {
      const candidate = new Date(from)
      candidate.setMinutes(rule.minute, 0, 0)
      if (candidate.getTime() <= from.getTime()) candidate.setHours(candidate.getHours() + 1)
      return candidate
    }
    case "daily":
      return nextDay(from, rule.time, 1, () => true)
    case "weekdays":
      return nextDay(from, rule.time, 7, (day) => WEEKDAYS.has(day.getDay()))
    case "weekly": {
      const days = new Set(rule.days)
      return nextDay(from, rule.time, 7, (day) => days.has(day.getDay()))
    }
    case "monthly":
      return nextMonth(from, 12, (month) => [onMonthDay(month, rule.day, rule.time)])
    case "everyMinutes":
      return nextStep(Date.parse(rule.anchor), rule.every * 60_000, from)
    case "everyHours": {
      const base = new Date(rule.anchor)
      base.setMinutes(rule.minute, 0, 0)
      return nextStep(base.getTime(), rule.every * 3_600_000, from)
    }
    case "everyDays": {
      const anchor = dayNumber(new Date(rule.anchor))
      return nextDay(
        from,
        rule.time,
        rule.every,
        (day) => mod(dayNumber(day) - anchor, rule.every) === 0,
      )
    }
    case "everyWeeks": {
      const anchor = weekNumber(new Date(rule.anchor))
      const days = new Set(rule.days)
      return nextDay(
        from,
        rule.time,
        7 * (rule.every + 1),
        (day) => days.has(day.getDay()) && mod(weekNumber(day) - anchor, rule.every) === 0,
      )
    }
    case "everyMonths": {
      const anchor = monthNumber(new Date(rule.anchor))
      return nextMonth(from, rule.every, (month) =>
        mod(month - anchor, rule.every) === 0
          ? rule.days.map((day) => onMonthDay(month, day, rule.time))
          : [],
      )
    }
    case "everyMonthsWeekday": {
      const anchor = monthNumber(new Date(rule.anchor))
      return nextMonth(from, rule.every, (month) => {
        if (mod(month - anchor, rule.every) !== 0) return []
        const first = new Date(Math.floor(month / 12), mod(month, 12), 1).getDay()
        return [onMonthDay(month, 1 + mod(rule.weekday - first, 7), rule.time)]
      })
    }
    case "everyYears": {
      const anchor = new Date(rule.anchor).getFullYear()
      return nextMonth(from, 12 * rule.every, (month) => {
        const year = Math.floor(month / 12)
        return mod(month, 12) === rule.month - 1 && mod(year - anchor, rule.every) === 0
          ? [onMonthDay(month, rule.day, rule.time)]
          : []
      })
    }
  }
}

/**
 * 考虑结束日期的下一次运行时间：超过 endsAt 时返回 null，任务就此完成。
 */
export function nextScheduleRunBefore(
  rule: ScheduleRule,
  from: Date,
  endsAt: string | null,
): Date | null {
  const next = nextScheduleRun(rule, from)
  return endsAt !== null && next.getTime() > Date.parse(endsAt) ? null : next
}
