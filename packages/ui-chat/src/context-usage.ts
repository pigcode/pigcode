/**
 * 从会话事件里取当前的上下文占用：最近一条 context.updated。换了 Agent 或者原生会话接不上、开了新会话以后，
 * 之前的数字说的是另一个会话，不再算数，直到新会话报上来。
 */
import type { ThreadEvent } from "@pigcode/contracts"
import type { ContextUsage } from "@pigcode/ui-composer"

export function latestContextUsage(events: readonly ThreadEvent[]): ContextUsage | null {
  let latest: ContextUsage | null = null
  for (const event of events) {
    const payload = (event.payload ?? {}) as Record<string, unknown>
    if (event.type === "thread.updated" && event.runId === null && payload.agentId) latest = null
    else if (event.type === "notice" && payload.key === "session.resumeFailed") latest = null
    else if (event.type === "context.updated" && typeof payload.usedTokens === "number") {
      latest = {
        usedTokens: payload.usedTokens,
        maxTokens: typeof payload.maxTokens === "number" ? payload.maxTokens : null,
        autoCompactTokens:
          typeof payload.autoCompactTokens === "number" ? payload.autoCompactTokens : null,
      }
    }
  }
  return latest
}
