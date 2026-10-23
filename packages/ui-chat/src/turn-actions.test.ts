/** 验证回复时间的写法：当天、昨天、今年与更早。 */
import { describe, expect, it } from "vitest"
import { formatReplyTime } from "./turn-actions"

const local = (month: number, day: number, hour: number, minute: number, year = 2026) =>
  new Date(year, month - 1, day, hour, minute).toISOString()

describe("formatReplyTime", () => {
  const now = Date.parse(local(10, 22, 18, 0))

  it("shows only the time today and 'yesterday' the day before", () => {
    expect(formatReplyTime(local(10, 22, 14, 5), "zh-CN", "昨天 {time}", now)).toBe("14:05")
    expect(formatReplyTime(local(10, 21, 9, 30), "zh-CN", "昨天 {time}", now)).toBe("昨天 09:30")
  })

  it("adds the date this year and the year before that", () => {
    expect(formatReplyTime(local(10, 1, 8, 0), "zh-CN", "昨天 {time}", now)).toBe("10/1 08:00")
    expect(formatReplyTime(local(12, 31, 23, 0, 2025), "zh-CN", "昨天 {time}", now)).toBe(
      "2025/12/31 23:00",
    )
  })

  it("returns nothing for invalid input", () => {
    expect(formatReplyTime("nope", "en-US", "Yesterday {time}", now)).toBe("")
  })
})
