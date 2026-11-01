/**
 * 界面里所有时间的写法，都跟随界面语言：侧栏的短相对时间、检查点与 Diff 基准等处的绝对时间、
 * 时间线的回复时间，以及耗时。组件不直接调用 toLocaleString 或 Intl.DateTimeFormat。
 */
import { translate, type Locale, type MessageKey } from "./locale/locale"

/** ISO 字符串、毫秒时间戳或 Date。 */
export type TimeValue = string | number | Date

function toDate(value: TimeValue): Date | null {
  const date = value instanceof Date ? value : new Date(value)
  return Number.isNaN(date.getTime()) ? null : date
}

function sameDay(left: Date, right: Date): boolean {
  return (
    left.getFullYear() === right.getFullYear() &&
    left.getMonth() === right.getMonth() &&
    left.getDate() === right.getDate()
  )
}

/** 带单位的数字的最短写法：中文「3分钟」，英文「3m」。 */
function narrowUnit(count: number, unit: "minute" | "hour" | "day", locale: Locale): string {
  return new Intl.NumberFormat(locale, { style: "unit", unit, unitDisplay: "narrow" }).format(count)
}

/**
 * 常驻显示的短相对时间：「刚刚 / 3分钟 / 2小时 / 5天」，英文「now / 3m / 2h / 5d」；超过 7 天写月日。
 * 不用 Intl.RelativeTimeFormat：它总会带上「前」或「ago」，侧栏放不下。非法时间返回空字符串。
 */
export function formatRelativeTime(value: TimeValue, locale: Locale, now = Date.now()): string {
  const date = toDate(value)
  if (!date) return ""
  const minutes = Math.floor((now - date.getTime()) / 60_000)
  if (minutes < 1) return translate(locale, "time.justNow")
  if (minutes < 60) return narrowUnit(minutes, "minute", locale)
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return narrowUnit(hours, "hour", locale)
  const days = Math.floor(hours / 24)
  if (days < 7) return narrowUnit(days, "day", locale)
  return new Intl.DateTimeFormat(locale, { month: "short", day: "numeric" }).format(date)
}

/** 完整的日期和时间，例如「2026年1月1日 08:00」、「Jan 1, 2026, 8:00 AM」；非法字符串原样返回。 */
export function formatDateTime(value: TimeValue, locale: Locale): string {
  const date = toDate(value)
  if (!date) return typeof value === "string" ? value : ""
  return new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeStyle: "short" }).format(date)
}

/**
 * 时间线的回复时间：当天只写「14:05」，前一天写「昨天 14:05」，今年写月日与时间，更早的再带上年份。
 * 非法时间返回空字符串。
 */
export function formatReplyTime(value: TimeValue, locale: Locale, now = Date.now()): string {
  const date = toDate(value)
  if (!date) return ""
  const today = new Date(now)
  const time = new Intl.DateTimeFormat(locale, { hour: "2-digit", minute: "2-digit" }).format(date)
  if (sameDay(date, today)) return time
  const before = new Date(today)
  before.setDate(today.getDate() - 1)
  if (sameDay(date, before)) {
    return translate(locale, "chat.message.time.yesterday").replace("{time}", time)
  }
  return new Intl.DateTimeFormat(locale, {
    ...(date.getFullYear() === today.getFullYear() ? {} : { year: "numeric" }),
    month: "numeric",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(date)
}

const DURATION_UNITS: ReadonlyArray<[seconds: number, key: MessageKey]> = [
  [86_400, "time.duration.day"],
  [3_600, "time.duration.hour"],
  [60, "time.duration.minute"],
  [1, "time.duration.second"],
]

/**
 * 耗时：「12 秒 / 3 分 5 秒 / 1 时 2 分 / 2 天 3 时」，英文「12s / 3m 5s」。四舍五入到秒、至少 1 秒，
 * 只取最大的两个非零单位。
 */
export function formatDuration(ms: number, locale: Locale): string {
  let rest = Math.max(1, Math.round(ms / 1000))
  const parts: string[] = []
  for (const [size, key] of DURATION_UNITS) {
    const value = Math.floor(rest / size)
    rest %= size
    if (value > 0) parts.push(translate(locale, key).replace("{count}", String(value)))
  }
  return parts.slice(0, 2).join(" ")
}
