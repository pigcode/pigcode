/**
 * 手机端 Agent 实例管理处理器：
 * - 复用桌面端 listAgents / validateAgentSettings / AgentSecrets 脱敏边界；
 * - 统一分流默认实例（仅允许启停与更新设置）与自定义实例（完整 CRUD）；
 * - 裁剪检测状态中的电脑本机可执行文件绝对路径 command。
 */
import type { Context } from "cordis"
import {
  CUSTOM_MODELS_KEY,
  HIDDEN_MODELS_KEY,
  mobileAgentCreateInstanceParams,
  mobileAgentCreateInstanceResult,
  mobileAgentDetectParams,
  mobileAgentDetectResult,
  mobileAgentListParams,
  mobileAgentListResult,
  mobileAgentMethods,
  mobileAgentModelsParams,
  mobileAgentModelsResult,
  mobileAgentRemoveInstanceParams,
  mobileAgentRemoveInstanceResult,
  mobileAgentSetDefaultParams,
  mobileAgentSetDefaultResult,
  mobileAgentUpdateInstanceParams,
  mobileAgentUpdateInstanceResult,
  type AgentInstance,
  type AgentStatus,
  type MobileAgentCreateInstanceParams,
  type MobileAgentDetectParams,
  type MobileAgentInstance,
  type MobileAgentModelItem,
  type MobileAgentModelsParams,
  type MobileAgentSetDefaultParams,
  type MobileAgentStatus,
  type MobileAgentUpdateInstanceParams,
  type RpcRequest,
} from "@pigcode/contracts"
import { AgentInstanceIdTakenError } from "../agents/errors"
import { listAgents, validateAgentSettings } from "../rpc/agents"
import { mobileParams as params, MobileRequestError } from "./request-error"

export const mobileAgentRequests = new Set<string>(Object.values(mobileAgentMethods))

function toMobileInstance(instance: AgentInstance): MobileAgentInstance {
  return {
    instanceId: instance.instanceId,
    agentId: instance.agentId,
    label: instance.label,
    ...(instance.accentColor ? { accentColor: instance.accentColor } : {}),
    enabled: instance.enabled,
    isDefault: instance.isDefault,
    values: instance.values,
  }
}

function toMobileStatus(status: AgentStatus): MobileAgentStatus {
  return {
    installed: status.installed,
    version: status.version,
    authenticated: status.authenticated,
    ...(status.usingCliLogin !== undefined ? { usingCliLogin: status.usingCliLogin } : {}),
    ...(status.credentialsConfigured !== undefined
      ? { credentialsConfigured: status.credentialsConfigured }
      : {}),
    ...(status.account !== undefined ? { account: status.account } : {}),
    ...(status.email !== undefined ? { email: status.email } : {}),
    ...(status.error !== undefined ? { error: status.error } : {}),
  }
}

function truncateError(error: string | null): string | null {
  if (error === null) return null
  return error.length > 1024 ? `${error.slice(0, 1023)}…` : error
}

function readStringList(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return value.filter((item): item is string => typeof item === "string" && item.trim().length > 0)
}

export class MobileAgentManage {
  constructor(
    private readonly ctx: Context,
    private readonly requireDevice: () => void,
  ) {}

  async dispatch(request: RpcRequest): Promise<unknown> {
    this.requireDevice()
    switch (request.method) {
      case mobileAgentMethods.list:
        params(mobileAgentListParams, request.params)
        return this.list()
      case mobileAgentMethods.detect:
        return this.detect(params(mobileAgentDetectParams, request.params))
      case mobileAgentMethods.models:
        return this.models(params(mobileAgentModelsParams, request.params))
      case mobileAgentMethods.setDefault:
        return this.setDefault(params(mobileAgentSetDefaultParams, request.params))
      case mobileAgentMethods.createInstance:
        return this.createInstance(params(mobileAgentCreateInstanceParams, request.params))
      case mobileAgentMethods.updateInstance:
        return this.updateInstance(params(mobileAgentUpdateInstanceParams, request.params))
      case mobileAgentMethods.removeInstance:
        return this.removeInstance(params(mobileAgentRemoveInstanceParams, request.params))
      default:
        throw new MobileRequestError("METHOD_NOT_AVAILABLE")
    }
  }

  private async list() {
    const raw = await listAgents(this.ctx)
    return mobileAgentListResult.parse({
      defaultAgentId: raw.defaultAgentId,
      defaultInstanceId: raw.defaultInstanceId,
      agents: raw.agents.map((agent) => ({
        agentId: agent.agentId,
        displayName: agent.displayName,
        pluginId: agent.pluginId,
        version: agent.version,
        builtin: agent.builtin,
        enabled: agent.enabled,
        registered: agent.registered,
        requiresInstance: agent.requiresInstance ?? false,
        acpRegistry: agent.acpRegistry ?? false,
        accountSetup: agent.accountSetup ?? false,
        secretReferences: agent.secretReferences ?? false,
        customModels: agent.customModels,
        description: agent.description,
        fields: agent.fields,
        error: truncateError(agent.error),
        instances: agent.instances.map(toMobileInstance),
      })),
    })
  }

  private async detect(input: MobileAgentDetectParams) {
    const raw = await this.ctx.agents.detect({
      ...(input.agentId ? { agentId: input.agentId } : {}),
      ...(input.instanceId ? { instanceId: input.instanceId } : {}),
      ...(input.refresh !== undefined ? { refresh: input.refresh } : {}),
    })
    const statuses: Record<string, MobileAgentStatus> = {}
    for (const [id, status] of Object.entries(raw)) {
      statuses[id] = toMobileStatus(status)
    }
    return mobileAgentDetectResult.parse({ statuses })
  }

  private async models(input: MobileAgentModelsParams) {
    const instanceId = input.instanceId ?? null
    const instance = instanceId ? this.ctx.agents.findInstance(instanceId) : null
    if (instanceId && !instance) {
      throw new MobileRequestError("AGENT_INSTANCE_NOT_FOUND")
    }
    const agentId = instance?.agentId ?? input.agentId
    if (!agentId || !this.ctx.agents.list().some((driver) => driver.id === agentId)) {
      throw new MobileRequestError("AGENT_NOT_FOUND")
    }
    const values = this.ctx.agents.getSettings(agentId, instanceId)
    const customSet = new Set(readStringList(values[CUSTOM_MODELS_KEY]))
    const hiddenSet = new Set(readStringList(values[HIDDEN_MODELS_KEY]))
    const catalog = await this.ctx.agents.models(agentId, instanceId)
    const items: MobileAgentModelItem[] = []
    const seen = new Set<string>()
    for (const model of catalog) {
      seen.add(model.id)
      items.push({
        id: model.id,
        name: model.displayName || model.id,
        isCustom: model.custom === true || customSet.has(model.id),
        hidden: model.hidden === true || hiddenSet.has(model.id),
      })
    }
    // 补全已隐藏但被上游过滤掉的模型，确保手机端可以重新取消隐藏。
    for (const hiddenId of hiddenSet) {
      if (seen.has(hiddenId)) continue
      seen.add(hiddenId)
      items.push({
        id: hiddenId,
        name: hiddenId,
        isCustom: customSet.has(hiddenId),
        hidden: true,
      })
    }
    for (const customId of customSet) {
      if (seen.has(customId)) continue
      seen.add(customId)
      items.push({
        id: customId,
        name: customId,
        isCustom: true,
        hidden: hiddenSet.has(customId),
      })
    }
    return mobileAgentModelsResult.parse({ models: items })
  }

  private setDefault(input: MobileAgentSetDefaultParams) {
    if (input.agentId !== null) {
      const hasAgent = this.ctx.agents.list().some((driver) => driver.id === input.agentId)
      if (!hasAgent) throw new MobileRequestError("AGENT_NOT_FOUND")
      if (input.instanceId) {
        const instance = this.ctx.agents.findInstance(input.instanceId)
        if (!instance || instance.agentId !== input.agentId) {
          throw new MobileRequestError("AGENT_INSTANCE_NOT_FOUND")
        }
      }
    }
    this.ctx.agents.setDefaultAgent(input.agentId, input.instanceId ?? null)
    return mobileAgentSetDefaultResult.parse({
      defaultAgentId: this.ctx.agents.configuredDefaultAgent(),
      defaultInstanceId: this.ctx.agents.configuredDefaultInstance(),
    })
  }

  private async createInstance(input: MobileAgentCreateInstanceParams) {
    const { agents } = await listAgents(this.ctx)
    const agent = agents.find((item) => item.agentId === input.agentId)
    if (!agent || !this.ctx.agents.list().some((driver) => driver.id === input.agentId)) {
      throw new MobileRequestError("AGENT_NOT_FOUND")
    }
    if (
      input.instanceId &&
      (this.ctx.agents.findInstance(input.instanceId) ||
        agents.some(
          (item) =>
            item.agentId === input.instanceId &&
            !(input.agentId === item.agentId && item.requiresInstance),
        ))
    ) {
      throw new MobileRequestError("AGENT_INSTANCE_ID_TAKEN")
    }
    let validatedValues: Record<string, unknown> | undefined
    if (input.values !== undefined) {
      try {
        validatedValues = validateAgentSettings(agent, input.values)
      } catch {
        throw new MobileRequestError("AGENT_SETTINGS_INVALID")
      }
    }
    if (input.copyFrom) {
      const source = this.ctx.agents.findInstance(input.copyFrom)
      if (!source || source.agentId !== input.agentId) {
        throw new MobileRequestError("AGENT_INSTANCE_NOT_FOUND")
      }
    }
    if (input.agentId === "acp") {
      const source = input.copyFrom ? this.ctx.agents.findInstance(input.copyFrom) : null
      const effective = validatedValues ?? (source?.agentId === "acp" ? source.values : {})
      if (
        ![effective.binaryPath, effective.registryId].some(
          (value) => typeof value === "string" && value.trim(),
        )
      ) {
        throw new MobileRequestError("AGENT_SETTINGS_INVALID")
      }
    }
    try {
      const created = this.ctx.agents.createInstance(input.agentId, input.label, {
        ...(input.instanceId !== undefined ? { instanceId: input.instanceId } : {}),
        ...(input.accentColor !== undefined ? { accentColor: input.accentColor } : {}),
        ...(validatedValues !== undefined ? { values: validatedValues } : {}),
        ...(input.copyFrom !== undefined ? { copyFrom: input.copyFrom } : {}),
      })
      return mobileAgentCreateInstanceResult.parse({ instance: toMobileInstance(created) })
    } catch (error) {
      if (error instanceof AgentInstanceIdTakenError) {
        throw new MobileRequestError("AGENT_INSTANCE_ID_TAKEN")
      }
      throw new MobileRequestError("AGENT_SETTINGS_INVALID")
    }
  }

  private async updateInstance(input: MobileAgentUpdateInstanceParams) {
    const existing = this.ctx.agents.findInstance(input.instanceId)
    if (!existing) throw new MobileRequestError("AGENT_INSTANCE_NOT_FOUND")

    const { patch } = input
    if (existing.isDefault && (patch.label !== undefined || patch.accentColor !== undefined)) {
      throw new MobileRequestError("AGENT_DEFAULT_INSTANCE_IMMUTABLE")
    }

    let validatedValues: Record<string, unknown> | undefined
    if (patch.values !== undefined) {
      const { agents } = await listAgents(this.ctx)
      const agent = agents.find((item) => item.agentId === existing.agentId)
      if (!agent) throw new MobileRequestError("AGENT_NOT_FOUND")
      try {
        validatedValues = validateAgentSettings(agent, patch.values)
      } catch {
        throw new MobileRequestError("AGENT_SETTINGS_INVALID")
      }
    }

    try {
      if (existing.isDefault) {
        if (patch.enabled !== undefined) {
          const driver = this.ctx.agents.list().find((item) => item.id === existing.agentId)
          if (!driver?.accountSetup) {
            throw new MobileRequestError("AGENT_DEFAULT_INSTANCE_IMMUTABLE")
          }
          await this.ctx.agents.updateInstance(input.instanceId, { enabled: patch.enabled })
        }
        if (validatedValues !== undefined) {
          this.ctx.agents.updateSettings(existing.agentId, validatedValues, input.instanceId)
        }
        const refreshed = this.ctx.agents.findInstance(input.instanceId)
        if (!refreshed) throw new MobileRequestError("AGENT_INSTANCE_NOT_FOUND")
        return mobileAgentUpdateInstanceResult.parse({ instance: toMobileInstance(refreshed) })
      }

      const updated = await this.ctx.agents.updateInstance(input.instanceId, {
        ...(patch.label !== undefined ? { label: patch.label } : {}),
        ...(patch.accentColor !== undefined ? { accentColor: patch.accentColor } : {}),
        ...(patch.enabled !== undefined ? { enabled: patch.enabled } : {}),
        ...(validatedValues !== undefined ? { values: validatedValues } : {}),
      })
      return mobileAgentUpdateInstanceResult.parse({ instance: toMobileInstance(updated) })
    } catch (error) {
      if (error instanceof MobileRequestError) throw error
      throw new MobileRequestError("AGENT_SETTINGS_INVALID")
    }
  }

  private async removeInstance(input: { instanceId: string }) {
    const existing = this.ctx.agents.findInstance(input.instanceId)
    if (!existing) throw new MobileRequestError("AGENT_INSTANCE_NOT_FOUND")
    if (existing.isDefault) throw new MobileRequestError("AGENT_DEFAULT_INSTANCE_IMMUTABLE")
    try {
      await this.ctx.agents.removeInstance(input.instanceId)
    } catch (error) {
      const code = (error as { code?: unknown } | null)?.code
      if (code === "AGENT_INSTANCE_IN_USE") {
        throw new MobileRequestError("AGENT_INSTANCE_IN_USE")
      }
      throw new MobileRequestError("COMMAND_FAILED")
    }
    return mobileAgentRemoveInstanceResult.parse({ removed: true, instanceId: input.instanceId })
  }
}
