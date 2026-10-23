/** 时长的显示与运行中的计时。 */
import { useEffect, useState } from "react"

const UNITS: ReadonlyArray<[seconds: number, zh: string, en: string]> = [
  [86_400, "天", "d"],
  [3_600, "时", "h"],
  [60, "分", "m"],
  [1, "秒", "s"],
]

/**
 * 把时长写成「12 秒 / 3 分 5 秒 / 1 时 2 分 / 2 天 3 时」，英文为「12s / 3m 5s」：四舍五入到秒、
 * 至少 1 秒，只取最大的两个非零单位。
 */
export function formatDuration(ms: number, locale: string): string {
  let rest = Math.max(1, Math.round(ms / 1000))
  const zh = locale.startsWith("zh")
  const parts: string[] = []
  for (const [size, zhUnit, enUnit] of UNITS) {
    const value = Math.floor(rest / size)
    rest %= size
    if (value > 0) parts.push(zh ? `${value} ${zhUnit}` : `${value}${enUnit}`)
  }
  return parts.slice(0, 2).join(" ")
}

/** 运行中每秒刷新一次当前时间；结束后停止计时。 */
export function useNow(active: boolean): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (!active) return undefined
    setNow(Date.now())
    const timer = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [active])
  return now
}

/** 两个时间点之间的毫秒数；缺任何一个时为 null。 */
export function elapsed(
  from: string | null | undefined,
  to: string | number | null | undefined,
): number | null {
  if (!from || to === null || to === undefined) return null
  const start = Date.parse(from)
  const end = typeof to === "number" ? to : Date.parse(to)
  return Number.isFinite(start) && Number.isFinite(end) ? Math.max(0, end - start) : null
}
