/**
 * `agent.*` 命令的分发：检测、模型目录、设置、实例的增删改与默认实例。
 * 从 RpcServer 里分出来，让 server.ts 的分发只留一次调用。
 */
import type { Context } from "cordis"
import { listAgents, validateAgentSettings } from "./agents"

/** 一个已解析的参数；各命令自己断言形状。 */
type Params = Record<string, unknown>

/** `agent.updateInstance` 允许改的字段。 */
interface InstancePatch {
  label?: string
  enabled?: boolean
  values?: Record<string, unknown>
}

/** 找不到 agent 时抛出可读的错误。 */
async function requireAgent(ctx: Context, agentId: string) {
  const agent = (await listAgents(ctx)).agents.find((item) => item.agentId === agentId)
  if (!agent) throw new Error(`agent not found: ${agentId}`)
  return agent
}

/** 设置值按它所属 agent 声明的字段校验，避免写进别的 agent 的键。 */
async function updateInstance(ctx: Context, value: Params): Promise<unknown> {
  const instanceId = value.instanceId as string
  const patch = value.patch as InstancePatch
  const instance = ctx.agents.findInstance(instanceId)
  if (!instance) throw new Error(`instance not found: ${instanceId}`)
  if (instance.isDefault) throw new Error(`default instance cannot be edited: ${instanceId}`)
  if (patch.values !== undefined) {
    const agent = await requireAgent(ctx, instance.agentId)
    validateAgentSettings(agent, patch.values)
  }
  return ctx.agents.updateInstance(instanceId, patch)
}

/** 保存某一实例（不传实例就是默认实例）的设置。 */
async function updateSettings(ctx: Context, value: Params): Promise<unknown> {
  const agentId = value.agentId as string
  const instanceId = value.instanceId as string | undefined
  const agent = await requireAgent(ctx, agentId)
  if (instanceId && !agent.instances.some((item) => item.instanceId === instanceId)) {
    throw new Error(`instance not found: ${instanceId}`)
  }
  const values = value.values as Record<string, unknown>
  validateAgentSettings(agent, values)
  return { values: ctx.agents.updateSettings(agentId, values, instanceId) }
}

/** 处理一条 `agent.*` 命令。参数在 RpcServer 里已经过 schema 校验。 */
export async function dispatchAgentCommand(
  ctx: Context,
  command: string,
  parsed: unknown,
): Promise<unknown> {
  const value = parsed as Params
  switch (command) {
    case "agent.detect":
      return ctx.agents.detect({
        agentId: value.agentId as string | undefined,
        instanceId: value.instanceId as string | undefined,
        refresh: value.refresh as boolean | undefined,
      })
    case "agent.registered":
      return ctx.agents.list()
    case "agent.default": {
      const choice = await ctx.agents.defaultAgent()
      return { id: choice.agentId, instanceId: choice.instanceId }
    }
    case "agent.models": {
      // 只给实例（界面按实例读取目录时）就先找到它属于哪个 Agent，避免把实例 id 当成 driver id。
      const instanceId = (value.instanceId as string) ?? null
      const instance = instanceId ? ctx.agents.findInstance(instanceId) : null
      const agentId = instance?.agentId ?? (value.agentId as string)
      return ctx.agents.models(agentId, instanceId)
    }
    case "agent.list":
      return listAgents(ctx)
    case "agent.updateSettings":
      return updateSettings(ctx, value)
    case "agent.createInstance": {
      const agentId = value.agentId as string
      if (!ctx.agents.list().some((driver) => driver.id === agentId)) {
        throw new Error(`agent not found: ${agentId}`)
      }
      return ctx.agents.createInstance(
        agentId,
        value.label as string,
        (value.copyFrom as string) ?? null,
      )
    }
    case "agent.updateInstance":
      return updateInstance(ctx, value)
    case "agent.removeInstance":
      ctx.agents.removeInstance(value.instanceId as string)
      return { ok: true }
    case "agent.setDefault": {
      const agentId = value.agentId as string | null
      ctx.agents.setDefaultAgent(agentId, (value.instanceId as string) ?? null)
      return { defaultAgentId: agentId }
    }
    default:
      throw new Error(`unsupported method: ${command}`)
  }
}
