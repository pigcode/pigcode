/** 向 CLI 问这个会话的上下文窗口和自动压缩线（Query.getContextUsage）。 */
import type { AgentEvent } from "@pigcode/contracts"
import type { Query } from "@anthropic-ai/claude-agent-sdk"

/** getContextUsage 里用得到的几项；SDK 类型里的字段名在运行时是 camelCase。 */
interface ContextUsageReply {
  totalTokens?: unknown
  maxTokens?: unknown
  autoCompactThreshold?: unknown
  isAutoCompactEnabled?: unknown
}

const positive = (value: unknown): number | null =>
  typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.round(value) : null

/**
 * 要在 init 之后、result 之前问：单条 prompt 的 Query 在 result 后就关了，再问会报
 * 「Query closed before response received」。实测 summary 模式约 45 ms。问不到时返回 null。
 */
export async function readContextUsage(stream: Query): Promise<{
  event: AgentEvent
  limit: { maxTokens: number | null; autoCompactTokens: number | null }
} | null> {
  if (typeof stream.getContextUsage !== "function") return null
  const reply = (await stream.getContextUsage({ detail: "summary" })) as ContextUsageReply
  const maxTokens = positive(reply.maxTokens)
  const autoCompactTokens =
    reply.isAutoCompactEnabled === false ? null : positive(reply.autoCompactThreshold)
  const used =
    typeof reply.totalTokens === "number" ? Math.max(0, Math.round(reply.totalTokens)) : 0
  return {
    limit: { maxTokens, autoCompactTokens },
    event: { type: "context.updated", usedTokens: used, maxTokens, autoCompactTokens },
  }
}
