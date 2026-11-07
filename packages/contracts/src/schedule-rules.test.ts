/**
 * 验证定时任务规则的下一次运行时间，以及 schedule.* 命令的参数。
 * 时间都用本地时间构造，测试在任何时区都成立；2026-11-06 是周五。
 */
import { describe, expect, it } from "vitest"
import { commandSchemas } from "./commands"
import type { ScheduleRule } from "./domain"
import { nextScheduleRun, nextScheduleRunBefore } from "./schedule-rules"

const at = (month: number, day: number, hours: number, minutes = 0, year = 2026) =>
  new Date(year, month - 1, day, hours, minutes)
const next = (rule: ScheduleRule, from: Date) => nextScheduleRun(rule, from)

describe("nextScheduleRun", () => {
  it("runs hourly at the given minute, strictly after the start time", () => {
    expect(next({ kind: "hourly", minute: 30 }, at(11, 6, 10, 20))).toEqual(at(11, 6, 10, 30))
    expect(next({ kind: "hourly", minute: 15 }, at(11, 6, 10, 20))).toEqual(at(11, 6, 11, 15))
    expect(next({ kind: "hourly", minute: 15 }, at(11, 6, 10, 15))).toEqual(at(11, 6, 11, 15))
  })

  it("runs daily today if the time is still ahead, otherwise tomorrow, across month ends", () => {
    expect(next({ kind: "daily", time: "09:00" }, at(11, 6, 8))).toEqual(at(11, 6, 9))
    expect(next({ kind: "daily", time: "09:00" }, at(11, 6, 9))).toEqual(at(11, 7, 9))
    expect(next({ kind: "daily", time: "09:00" }, at(11, 30, 23))).toEqual(at(12, 1, 9))
  })

  it("runs on weekdays only, skipping from Friday evening to Monday", () => {
    const rule: ScheduleRule = { kind: "weekdays", time: "09:00" }
    expect(next(rule, at(11, 6, 8))).toEqual(at(11, 6, 9))
    expect(next(rule, at(11, 6, 18))).toEqual(at(11, 9, 9))
    expect(next(rule, at(11, 7, 12))).toEqual(at(11, 9, 9))
  })

  it("runs weekly on the picked days", () => {
    const rule: ScheduleRule = { kind: "weekly", days: [3, 5], time: "16:00" }
    expect(next(rule, at(11, 5, 17))).toEqual(at(11, 6, 16))
    expect(next(rule, at(11, 6, 16))).toEqual(at(11, 11, 16))
  })

  it("runs monthly on the day, landing on the last day of shorter months", () => {
    const rule: ScheduleRule = { kind: "monthly", day: 31, time: "09:00" }
    expect(next(rule, at(11, 6, 8))).toEqual(at(11, 30, 9))
    expect(next(rule, at(11, 30, 10))).toEqual(at(12, 31, 9))
    expect(next(rule, at(1, 31, 10, 0, 2027))).toEqual(at(2, 28, 9, 0, 2027))
  })

  it("repeats every N minutes and hours from the anchor", () => {
    const anchor = at(11, 6, 9).toISOString()
    expect(next({ kind: "everyMinutes", every: 45, anchor }, at(11, 6, 10))).toEqual(
      at(11, 6, 10, 30),
    )
    expect(next({ kind: "everyMinutes", every: 45, anchor }, at(11, 6, 8))).toEqual(at(11, 6, 9))
    expect(next({ kind: "everyHours", every: 3, minute: 15, anchor }, at(11, 6, 10))).toEqual(
      at(11, 6, 12, 15),
    )
  })

  it("repeats every N days and weeks in step with the anchor", () => {
    const anchor = at(11, 2, 8).toISOString()
    // 11-02 起每 3 天：11-05、11-08……
    expect(next({ kind: "everyDays", every: 3, time: "09:00", anchor }, at(11, 6, 8))).toEqual(
      at(11, 8, 9),
    )
    // 11-02 所在的周起每 2 周的周一和周四：11-02 周、11-16 周……
    const weeks: ScheduleRule = {
      kind: "everyWeeks",
      every: 2,
      days: [1, 4],
      time: "10:00",
      anchor,
    }
    expect(next(weeks, at(11, 6, 8))).toEqual(at(11, 16, 10))
    expect(next(weeks, at(11, 16, 11))).toEqual(at(11, 19, 10))
  })

  it("repeats every N months by date or on the first weekday, and every N years", () => {
    const anchor = at(11, 1, 8).toISOString()
    const dates: ScheduleRule = {
      kind: "everyMonths",
      every: 2,
      days: [1, 15],
      time: "09:00",
      anchor,
    }
    expect(next(dates, at(11, 6, 8))).toEqual(at(11, 15, 9))
    expect(next(dates, at(11, 15, 10))).toEqual(at(1, 1, 9, 0, 2027))
    const firstMonday: ScheduleRule = {
      kind: "everyMonthsWeekday",
      every: 1,
      weekday: 1,
      time: "09:00",
      anchor,
    }
    expect(next(firstMonday, at(11, 6, 8))).toEqual(at(12, 7, 9))
    const yearly: ScheduleRule = {
      kind: "everyYears",
      every: 1,
      month: 2,
      day: 29,
      time: "09:00",
      anchor,
    }
    expect(next(yearly, at(11, 6, 8))).toEqual(at(2, 28, 9, 0, 2027))
  })

  it("stops after the end date", () => {
    const rule: ScheduleRule = { kind: "daily", time: "09:00" }
    const endsAt = at(11, 7, 23, 59).toISOString()
    expect(nextScheduleRunBefore(rule, at(11, 6, 10), endsAt)).toEqual(at(11, 7, 9))
    expect(nextScheduleRunBefore(rule, at(11, 7, 10), endsAt)).toBeNull()
    expect(nextScheduleRunBefore(rule, at(11, 7, 10), null)).toEqual(at(11, 8, 9))
  })
})

describe("schedule commands", () => {
  it("takes a title, a rule and an end date, with defaults for what's left out", () => {
    const create = commandSchemas["schedule.create"]
    const base = { threadId: "th_1", prompt: "digest", rule: { kind: "daily", time: "09:00" } }
    expect(create.parse(base)).toMatchObject({ title: "", endsAt: null, enabled: true })
    expect(create.parse({ ...base, title: "  Standup  " })).toMatchObject({ title: "Standup" })
    expect(() => create.parse({ ...base, rule: { kind: "daily", time: "9:00" } })).toThrow()
    expect(() =>
      create.parse({
        ...base,
        rule: { kind: "everyDays", every: 201, time: "09:00", anchor: "x" },
      }),
    ).toThrow()

    const update = commandSchemas["schedule.update"]
    expect(update.parse({ id: "sch_1", endsAt: null })).toEqual({ id: "sch_1", endsAt: null })
    expect(commandSchemas["schedule.runs"].parse({ id: "sch_1" })).toEqual({
      id: "sch_1",
      limit: 20,
      offset: 0,
    })
  })
})
