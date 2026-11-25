import {
  DEFAULT_RUNTIME_MODE,
  mobileThreadComposerState,
  normalizeRuntimeMode,
  type MobileContextUsage,
  type MobileThreadComposerState,
  type ThreadEvent,
} from "@pigcode/contracts"
import type { Context } from "cordis"
import { modesForAgent } from "../agents/execution-modes"
import { record } from "./timeline-projection"

function nonNegativeInt(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? Math.max(0, Math.trunc(value)) : null
}

/**
 * 与桌面端 `latestContextUsage` 保持完全一致的投影与清零规则：
 * 遇到换 Agent（`thread.updated` 且 `runId === null && payload.agentId`）或
 * 原生会话恢复失败（`notice` 且 `key === "session.resumeFailed"`）时清零；
 * 收到 `context.updated` 时更新为最新值。
 */
export function applyContextUsageEvent(
  current: MobileContextUsage | null,
  event: ThreadEvent,
): { usage: MobileContextUsage | null; changed: boolean } {
  const payload = record(event.payload)
  if (event.type === "thread.updated" && event.runId === null && payload.agentId) {
    return { usage: null, changed: current !== null }
  }
  if (event.type === "notice" && payload.key === "session.resumeFailed") {
    return { usage: null, changed: current !== null }
  }
  if (event.type === "context.updated") {
    const usedTokens = nonNegativeInt(payload.usedTokens)
    if (usedTokens !== null) {
      const next: MobileContextUsage = {
        usedTokens,
        maxTokens: nonNegativeInt(payload.maxTokens),
        autoCompactTokens: nonNegativeInt(payload.autoCompactTokens),
      }
      const changed =
        current === null ||
        current.usedTokens !== next.usedTokens ||
        current.maxTokens !== next.maxTokens ||
        current.autoCompactTokens !== next.autoCompactTokens
      return { usage: next, changed }
    }
  }
  return { usage: current, changed: false }
}

export function latestThreadContextUsage(
  ctx: Context,
  threadId: string,
): MobileContextUsage | null {
  let latest: MobileContextUsage | null = null
  for (const event of ctx.sessions.read(threadId, 0)) {
    latest = applyContextUsageEvent(latest, event).usage
  }
  return latest
}

export function buildThreadComposerState(
  ctx: Context,
  threadId: string,
  contextUsage?: MobileContextUsage | null,
  includeAttachments = false,
): MobileThreadComposerState | undefined {
  const thread = ctx.threads.get(threadId)
  if (!thread) return undefined
  const agentId = thread.lastAgentId ?? thread.defaultAgentId
  const instanceId = thread.lastInstanceId ?? thread.defaultInstanceId ?? agentId
  const modes = modesForAgent(ctx, agentId, instanceId)
  const permissionMode = normalizeRuntimeMode(thread.permissionMode, agentId) ?? DEFAULT_RUNTIME_MODE
  const planMode = thread.planMode === true || thread.permissionMode === "plan"
  const supportsPlanMode = modes?.plan === true
  const supportsImages =
    ctx.agents.list().find((agent) => agent.id === agentId)?.features.images === true
  const usage =
    contextUsage === undefined ? latestThreadContextUsage(ctx, threadId) : contextUsage
  return mobileThreadComposerState.parse({
    instanceId,
    agentId,
    modelId: thread.lastModelId ?? null,
    permissionMode,
    planMode,
    supportsPlanMode,
    ...(includeAttachments ? { supportsImages } : {}),
    contextUsage: usage,
  })
}
