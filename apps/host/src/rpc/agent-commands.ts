/**
 * `agent.*` 命令的分发：检测、模型目录、`/` 命令、设置、实例的增删改与默认实例。
 * 从 RpcServer 里分出来，让 server.ts 的分发只留一次调用。
 */
import type { Context } from "cordis"
import type { CommandParams } from "@pigcode/contracts"
import { AgentInstanceIdTakenError } from "../agents/errors"
import { listAgents, validateAgentSettings } from "./agents"

/** 一个已解析的参数；各命令自己断言形状。 */
type Params = Record<string, unknown>

/** `agent.updateInstance` 允许改的字段。 */
interface InstancePatch {
  accentColor?: string | null
  label?: string
  enabled?: boolean
  values?: Record<string, unknown>
}

/** `/` 命令的工作目录：线程的，没有线程时项目的，都没有时 null（只列用户级命令）。 */
function commandCwd(ctx: Context, value: Params): string | null {
  if (typeof value.threadId === "string") return ctx.workspace.root(value.threadId)
  if (typeof value.projectId === "string")
    return ctx.projects.get(value.projectId)?.rootPath ?? null
  return null
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
  if (
    instance.isDefault &&
    (patch.enabled === undefined ||
      patch.label !== undefined ||
      patch.accentColor !== undefined ||
      patch.values !== undefined)
  )
    throw new Error(`default instance cannot be edited: ${instanceId}`)
  if (patch.values !== undefined) {
    const agent = await requireAgent(ctx, instance.agentId)
    patch.values = validateAgentSettings(agent, patch.values)
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
  return {
    values: ctx.agents.updateSettings(agentId, validateAgentSettings(agent, values), instanceId),
  }
}

/** 保存前校验配置，已停用插件的默认实例 ID 也保留。 */
async function createInstance(
  ctx: Context,
  { agentId, label, preparedVersion, ...options }: CommandParams<"agent.createInstance">,
): Promise<unknown> {
  if (preparedVersion && agentId !== "acp")
    throw new Error("Only ACP instances use prepared Registry runtimes")
  if (options.instanceId !== undefined || options.values !== undefined) {
    const { agents } = await listAgents(ctx)
    if (
      options.instanceId &&
      (ctx.agents.findInstance(options.instanceId) ||
        agents.some(
          (agent) =>
            agent.agentId === options.instanceId &&
            !(agentId === agent.agentId && agent.requiresInstance),
        ))
    ) {
      throw new AgentInstanceIdTakenError(options.instanceId)
    }
    if (options.values !== undefined) {
      const agent = agents.find((item) => item.agentId === agentId)
      if (!agent) throw new Error(`agent not found: ${agentId}`)
      options.values = validateAgentSettings(agent, options.values)
    }
  }
  if (!ctx.agents.list().some((driver) => driver.id === agentId)) {
    throw new Error(`agent not found: ${agentId}`)
  }
  if (agentId === "acp") {
    const source = options.copyFrom ? ctx.agents.findInstance(options.copyFrom) : null
    const values = options.values ?? (source?.agentId === agentId ? source.values : {})
    if (
      ![values.binaryPath, values.registryId].some(
        (value) => typeof value === "string" && value.trim(),
      )
    )
      throw new Error("Choose a local ACP command or an ACP Registry agent")
    if (preparedVersion) {
      if (
        typeof values.registryId !== "string" ||
        (typeof values.binaryPath === "string" && values.binaryPath.trim())
      )
        throw new Error("A prepared version requires a managed ACP Registry runtime")
      await ctx.agents.activateAcpRegistry(values.registryId, preparedVersion)
    }
  }
  return ctx.agents.createInstance(agentId, label, options)
}

/** 处理一条 `agent.*` 命令。参数在 RpcServer 里已经过 schema 校验。 */
export async function dispatchAgentCommand(
  ctx: Context,
  command: string,
  parsed: unknown,
): Promise<unknown> {
  const value = parsed as Params
  switch (command) {
    case "agent.setClaudeIdleCompaction":
      ctx.settings.set("claude.idleCompaction", value.mode)
      return { mode: value.mode }
    case "agent.acpRegistry":
      return ctx.agents.acpRegistry()
    case "agent.prepareAcpRegistry":
      return ctx.agents.prepareAcpRegistry(value.registryId as string)
    case "agent.auth": {
      const { instanceId, request } = parsed as CommandParams<"agent.auth">
      return ctx.agents.auth(instanceId, request)
    }
    case "agent.cancelCliUpdate":
      ctx.agents.cancelCliUpdate(value.instanceId as string)
      return { ok: true }
    case "agent.removeCli":
      await ctx.agents.removeCli(value.instanceId as string)
      return { ok: true }
    case "agent.cliUpdates":
      return ctx.agents.cliUpdates()
    case "agent.checkCliUpdates":
      return ctx.agents.checkCliUpdates(value.instanceId as string | undefined)
    case "agent.updateCli":
      return ctx.agents.updateCli(value.instanceId as string)
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
      const models = await ctx.agents.models(agentId, instanceId)
      if (value.withModes !== true) return models
      const configured = ctx.agents
        .listInstances(agentId)
        .find((item) => item.instanceId === instanceId)
      return {
        models,
        ...(configured?.executionModes ? { executionModes: configured.executionModes } : {}),
      }
    }
    case "agent.commands": {
      const instance = ctx.agents.findInstance(value.instanceId as string)
      if (!instance) return []
      return ctx.agents.commands(
        instance.agentId,
        instance.instanceId,
        commandCwd(ctx, value),
        value.refresh === true,
      )
    }
    case "agent.list":
      return listAgents(ctx)
    case "agent.updateSettings":
      return updateSettings(ctx, value)
    case "agent.createInstance":
      return createInstance(ctx, parsed as CommandParams<"agent.createInstance">)
    case "agent.updateInstance":
      return updateInstance(ctx, value)
    case "agent.removeInstance":
      await ctx.agents.removeInstance(value.instanceId as string)
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
