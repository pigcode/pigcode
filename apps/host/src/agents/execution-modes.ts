import type { Context } from "cordis"
import {
  DEFAULT_RUNTIME_MODE,
  agentExecutionModesSchema,
  normalizeRuntimeMode,
  type AgentExecutionModes,
  type AgentModeSelection,
  type Thread,
} from "@pigcode/contracts"
import type { AgentDriver, AgentInstanceContext } from "./driver"

export function modesOf(
  driver: AgentDriver,
  instance?: AgentInstanceContext,
): AgentExecutionModes | null {
  const options = (instance && driver.modesForInstance?.(instance)) ?? driver.executionModes
  return options ? agentExecutionModesSchema.parse(options) : null
}

export function registeredAgents(drivers: ReadonlyMap<string, AgentDriver>) {
  return [...drivers.values()].map((driver) => ({
    id: driver.id,
    displayName: driver.displayName,
    features: driver.features,
    executionModes: modesOf(driver),
    ...(driver.requiresInstance ? { requiresInstance: true } : {}),
    ...(driver.accountSetup ? { accountSetup: true } : {}),
    ...(driver.acpRegistry ? { acpRegistry: true } : {}),
    ...(driver.removeManagedCli ? { managedCli: true } : {}),
  }))
}

/** 权限是会话级的统一档位；插件只声明独立计划能力，并实现原生参数映射。 */
export function resolveModes(
  modes: AgentExecutionModes | null | undefined,
  input: { permissionMode?: string | undefined; planMode?: boolean | undefined },
  agentId?: string,
): AgentModeSelection {
  const value = input.permissionMode ?? DEFAULT_RUNTIME_MODE
  const permissionMode = normalizeRuntimeMode(value, agentId)
  if (!permissionMode || (modes?.permissions && !modes.permissions.includes(permissionMode)))
    throw new Error(`Unsupported runtime permission mode: ${value}`)
  const planMode = input.permissionMode === "plan" || (input.planMode ?? false)
  if (planMode && !modes?.plan) throw new Error("Agent does not support plan mode")
  return { permissionMode, planMode }
}

export function modesForAgent(ctx: Context, agentId: string, instanceId?: string | null) {
  const instance = instanceId
    ? ctx.agents.listInstances(agentId).find((item) => item.instanceId === instanceId)
    : undefined
  return (
    instance?.executionModes ??
    ctx.agents.list().find((agent) => agent.id === agentId)?.executionModes ??
    null
  )
}

export function updateThreadModes(
  ctx: Context,
  threadId: string,
  patch: Partial<AgentModeSelection>,
): Thread {
  const thread = ctx.threads.get(threadId)
  if (!thread) throw new Error(`thread not found: ${threadId}`)
  const agentId = thread.lastAgentId ?? thread.defaultAgentId
  const selected = resolveModes(
    modesForAgent(ctx, agentId, thread.lastInstanceId ?? thread.defaultInstanceId),
    {
      permissionMode: thread.permissionMode,
      planMode: thread.planMode ?? false,
      ...patch,
    },
    agentId,
  )
  const updated = ctx.threads.setExecutionModes(threadId, selected)!
  ctx.sessions.append({
    threadId,
    runId: null,
    type: "thread.updated",
    payload: selected,
    schemaVersion: 1,
    createdAt: new Date().toISOString(),
  })
  return updated
}

/** 切换 Agent 保留统一权限与计划选择，不恢复另一套实例偏好。 */
export function modesForSwitch(
  ctx: Context,
  threadId: string,
  agentId: string,
  instanceId?: string,
): AgentModeSelection {
  const thread = ctx.threads.get(threadId)
  if (!thread) throw new Error(`thread not found: ${threadId}`)
  const modes = modesForAgent(ctx, agentId, instanceId)
  // 允许先切换实例。若原权限不可用，保留用户选择，直到用户明确换档才允许运行。
  return resolveModes(
    modes && { plan: modes.plan },
    thread,
    thread.lastAgentId ?? thread.defaultAgentId,
  )
}
