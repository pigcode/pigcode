import { normalizeRuntimeMode, type AgentEvent, type AgentExecutionModes } from "@pigcode/contracts"
import type { AgentRuntime, AgentSessionHandle } from "@pigcode/plugin-sdk"
import type { Options } from "@anthropic-ai/claude-agent-sdk"

export const claudeExecutionModes: AgentExecutionModes = { plan: true }

export function claudePermissionMode(
  mode: string,
  plan: boolean,
): NonNullable<Options["permissionMode"]> {
  // 旧的只读/计划会话兼容成原生 plan；新菜单只提供独立的计划开关。
  if (plan || mode === "plan" || mode === "read-only") return "plan"
  // 保留旧的程序化只拒绝模式，统一菜单不再暴露它。
  if (mode === "dontAsk") return "dontAsk"
  switch (normalizeRuntimeMode(mode, "claude")) {
    case "approval-required":
      return "default"
    case "auto-accept-edits":
      return "acceptEdits"
    case "auto":
      return "auto"
    case "full-access":
      return "bypassPermissions"
    default:
      throw new Error(`Unsupported Claude permission mode: ${mode}`)
  }
}

/** 只同步成功的原生模式切换；拒绝计划或工具失败时保留原状态。 */
export function syncClaudePlanMode(
  event: AgentEvent,
  session: AgentSessionHandle,
  runtime: AgentRuntime,
) {
  if (event.type !== "tool.completed" || event.isError) return
  if (event.name !== "EnterPlanMode" && event.name !== "ExitPlanMode") return
  const enabled = event.name === "EnterPlanMode"
  if (session.planMode === enabled) return
  session.planMode = enabled
  runtime.setPlanMode?.(enabled)
}
