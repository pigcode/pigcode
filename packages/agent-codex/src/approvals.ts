/** Codex 的审批请求与 Pigcode 审批决议之间的转换。 */
import type { ApprovalDecision, ApprovalRequest } from "@pigcode/plugin-sdk"

/** Codex 审批响应；Pigcode 只会产生这三种决议。 */
interface CodexApprovalResponse {
  decision: "accept" | "acceptForSession" | "decline"
}

/**
 * Codex 用 MCP elicitation 请求批准工具调用，靠 `_meta.codex_approval_kind` 和普通的 elicitation 区分。
 * 请求里没有单独的工具名字段，只能从 message 里取；取不到时退回到 server 名。
 */
export function mcpToolApproval(params: unknown): ApprovalRequest | null {
  const record = params as {
    serverName?: unknown
    message?: unknown
    _meta?: { codex_approval_kind?: unknown; tool_description?: unknown; tool_params?: unknown }
  }
  const server = record.serverName
  if (record._meta?.codex_approval_kind !== "mcp_tool_call" || typeof server !== "string") {
    return null
  }
  const tool =
    typeof record.message === "string" ? /tool "([^"]+)"/.exec(record.message)?.[1] : null
  const description = record._meta.tool_description
  return {
    toolName: tool ? `mcp__${server}__${tool}` : `mcp__${server}`,
    input: record._meta.tool_params ?? {},
    ...(typeof description === "string" ? { description } : {}),
  }
}

/** 把 Pigcode 审批决议映射为 MCP elicitation 的答复；本会话内放行靠 `_meta.persist`。 */
export function toElicitationResponse(decision: ApprovalDecision): Record<string, unknown> {
  if (decision === "deny") return { action: "decline" }
  if (decision === "allow-for-session") {
    return { action: "accept", content: {}, _meta: { persist: "session" } }
  }
  return { action: "accept", content: {} }
}

/** 把 Pigcode 审批决议映射为 Codex 的 accept/acceptForSession/decline。 */
export function toApprovalResponse(
  decision: ApprovalDecision,
  sessionDecision: "acceptForSession",
): CodexApprovalResponse {
  if (decision === "deny") return { decision: "decline" }
  if (decision === "allow-for-session") return { decision: sessionDecision }
  return { decision: "accept" }
}
