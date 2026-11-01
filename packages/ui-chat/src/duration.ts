/** 运行中的计时；耗时的写法见 ui-primitives 的 formatDuration。 */
import { useEffect, useState } from "react"

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
