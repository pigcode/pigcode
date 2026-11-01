/** 验证时间写法跟随界面语言：短相对时间、绝对时间、回复时间与耗时。 */
import { describe, expect, it } from "vitest"
import { formatDateTime, formatDuration, formatRelativeTime, formatReplyTime } from "./time"

const local = (month: number, day: number, hour: number, minute: number, year = 2026) =>
  new Date(year, month - 1, day, hour, minute).toISOString()

describe("formatRelativeTime", () => {
  const now = Date.parse("2026-10-21T12:00:00Z")

  it("writes the compact form the sidebar keeps visible", () => {
    expect(formatRelativeTime("2026-10-21T11:59:40Z", "zh-CN", now)).toBe("刚刚")
    expect(formatRelativeTime("2026-10-21T11:41:00Z", "zh-CN", now)).toBe("19分钟")
    expect(formatRelativeTime("2026-10-21T10:00:00Z", "zh-CN", now)).toBe("2小时")
    expect(formatRelativeTime("2026-10-16T12:00:00Z", "zh-CN", now)).toBe("5天")
    expect(formatRelativeTime("2026-10-21T11:59:40Z", "en-US", now)).toBe("now")
    expect(formatRelativeTime("2026-10-21T11:41:00Z", "en-US", now)).toBe("19m")
    expect(formatRelativeTime("2026-10-21T10:00:00Z", "en-US", now)).toBe("2h")
    expect(formatRelativeTime("2026-10-16T12:00:00Z", "en-US", now)).toBe("5d")
  })

  it("switches to the date after a week and ignores invalid input", () => {
    expect(formatRelativeTime(local(10, 1, 12, 0), "zh-CN", now)).toBe("10月1日")
    expect(formatRelativeTime(local(10, 1, 12, 0), "en-US", now)).toBe("Oct 1")
    expect(formatRelativeTime("not a date", "en-US", now)).toBe("")
  })
})

describe("formatDateTime", () => {
  it("writes the date and time in the UI language", () => {
    expect(formatDateTime(local(1, 2, 8, 5), "zh-CN")).toBe("2026年1月2日 08:05")
    expect(formatDateTime(local(1, 2, 8, 5), "en-US")).toBe("Jan 2, 2026, 8:05 AM")
  })

  it("keeps an invalid string as it is", () => {
    expect(formatDateTime("not a date", "zh-CN")).toBe("not a date")
  })
})

describe("formatReplyTime", () => {
  const now = Date.parse(local(10, 22, 18, 0))

  it("shows only the time today and 'yesterday' the day before", () => {
    expect(formatReplyTime(local(10, 22, 14, 5), "zh-CN", now)).toBe("14:05")
    expect(formatReplyTime(local(10, 21, 9, 30), "zh-CN", now)).toBe("昨天 09:30")
    expect(formatReplyTime(local(10, 21, 9, 30), "en-US", now)).toBe("Yesterday 09:30 AM")
  })

  it("adds the date this year and the year before that", () => {
    expect(formatReplyTime(local(10, 1, 8, 0), "zh-CN", now)).toBe("10/1 08:00")
    expect(formatReplyTime(local(12, 31, 23, 0, 2025), "zh-CN", now)).toBe("2025/12/31 23:00")
    expect(formatReplyTime(local(10, 1, 8, 0), "en-US", now)).toBe("10/1, 08:00 AM")
  })

  it("returns nothing for invalid input", () => {
    expect(formatReplyTime("nope", "en-US", now)).toBe("")
  })
})

describe("formatDuration", () => {
  it("rounds to seconds and keeps the two largest units", () => {
    expect(formatDuration(400, "zh-CN")).toBe("1 秒")
    expect(formatDuration(12_000, "zh-CN")).toBe("12 秒")
    expect(formatDuration(185_000, "zh-CN")).toBe("3 分 5 秒")
    expect(formatDuration(3_605_000, "zh-CN")).toBe("1 时 5 秒")
    expect(formatDuration(93_784_000, "zh-CN")).toBe("1 天 2 时")
    expect(formatDuration(12_000, "en-US")).toBe("12s")
    expect(formatDuration(185_000, "en-US")).toBe("3m 5s")
    expect(formatDuration(3_720_000, "en-US")).toBe("1h 2m")
  })
})
