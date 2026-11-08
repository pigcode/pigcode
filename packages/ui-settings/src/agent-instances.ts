/** Agent 实例的选择辅助：列表、默认实例与设置页正在编辑的那一个。 */
import type { AgentInstance, AgentSummary } from "@pigcode/contracts"

/**
 * 一个 agent 的实例列表；Host 没给出实例信息时按默认实例补一份。
 * 默认实例的 id 就是 agent id，值是 `agent.values`。
 */
export function instancesOf(agent: AgentSummary): AgentInstance[] {
  if (agent.instances.length > 0) return agent.instances
  return [
    {
      instanceId: agent.agentId,
      agentId: agent.agentId,
      label: agent.displayName,
      enabled: true,
      values: agent.values,
      isDefault: true,
      createdAt: null,
    },
  ]
}

/** 按 id 找实例；找不到或没给 id 时退回默认实例，编辑区不会空着。 */
export function instanceOf(
  agent: AgentSummary,
  instanceId: string | null | undefined,
): AgentInstance {
  const instances = instancesOf(agent)
  return (
    instances.find((instance) => instance.instanceId === instanceId) ??
    instances.find((instance) => instance.isDefault) ??
    instances[0]!
  )
}

/** 列表里的实例都能选的默认 id：Host 的选择还在、且确实属于这个 agent 时用它。 */
export function defaultInstanceOf(
  agent: AgentSummary,
  configured: string | null | undefined,
): string {
  const instances = instancesOf(agent)
  return instances.some((instance) => instance.instanceId === configured)
    ? (configured as string)
    : (instances.find((instance) => instance.isDefault)?.instanceId ?? instances[0]!.instanceId)
}

/** 实例的显示名：默认实例跟随 agent 的名字，其余用实例自己的名字。 */
export function instanceLabel(agent: AgentSummary, instance: AgentInstance): string {
  return instance.isDefault ? agent.displayName : instance.label
}

/** 设置页左侧列表的一项：实例与它所属的 agent。 */
export interface AgentInstanceEntry {
  agent: AgentSummary
  instance: AgentInstance
  /** 实例的显示名，见 instanceLabel。 */
  label: string
}

/** 全部 agent 的实例摊平成一张表，默认实例在前，同一 agent 的其余实例按创建顺序。 */
export function allInstances(agents: readonly AgentSummary[]): AgentInstanceEntry[] {
  return agents.flatMap((agent) =>
    instancesOf(agent).map((instance) => ({
      agent,
      instance,
      label: instanceLabel(agent, instance),
    })),
  )
}
