/**
 * Host 进程退出后的重启策略：活得够久的 Host 退出时立即重启；启动后很快就退出（例如数据库打不开）时
 * 按指数退避重启，连续快速失败达到上限后不再重启，由 main 弹出错误对话框，免得无限重启、空耗 CPU。
 */

/** 重启策略的参数。 */
export interface RestartPolicy {
  /** 活不到这么久就退出算一次快速失败。 */
  quickMs: number
  /** 连续快速失败达到这个次数后停止重启。 */
  maxQuickFailures: number
  /** 第一次快速失败后的等待时间，之后每次翻倍。 */
  baseDelayMs: number
  /** 等待时间的上限。 */
  maxDelayMs: number
}

export const DEFAULT_RESTART_POLICY: RestartPolicy = {
  quickMs: 10_000,
  maxQuickFailures: 5,
  baseDelayMs: 500,
  maxDelayMs: 8_000,
}

/** 一次退出后的决定；quickFailures 是算上这一次的连续快速失败次数，下次退出时传回来。 */
export type RestartDecision =
  | { action: "restart"; delayMs: number; quickFailures: number }
  | { action: "give-up"; quickFailures: number }

/**
 * Host 退出后怎么办。quickFailures 是这次之前的连续快速失败次数，uptimeMs 是这一次 Host 活了多久。
 * 活够 quickMs 的 Host 退出不算失败：计数清零、立即重启。
 */
export function decideRestart(
  quickFailures: number,
  uptimeMs: number,
  policy: RestartPolicy = DEFAULT_RESTART_POLICY,
): RestartDecision {
  if (uptimeMs >= policy.quickMs) return { action: "restart", delayMs: 0, quickFailures: 0 }
  const failures = quickFailures + 1
  if (failures >= policy.maxQuickFailures) return { action: "give-up", quickFailures: failures }
  const delayMs = Math.min(policy.baseDelayMs * 2 ** (failures - 1), policy.maxDelayMs)
  return { action: "restart", delayMs, quickFailures: failures }
}

const MAX_REASON = 2000

/** Host 启动失败前发给 main 的原因（`{ type: "fatal", message }`）；不是这种消息时返回 null。 */
export function readHostFatal(value: unknown): string | null {
  if (typeof value !== "object" || value === null) return null
  const record = value as Record<string, unknown>
  if (record.type !== "fatal" || typeof record.message !== "string") return null
  return record.message.slice(0, MAX_REASON)
}
