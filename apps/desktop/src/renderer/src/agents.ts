/**
 * 输入框模型选择器的数据：Agent 实例列表、各自的安装状态与按需读取的模型目录。
 * 一个 Agent 可以有多份配置（实例）；选择器列的是实例，模型目录也按实例读取。
 */
import { useCallback, useEffect, useRef, useState } from "react"
import type { AgentFeatures, AgentList, AgentModel } from "@pigcode/contracts"
import type { Connection } from "@pigcode/client-runtime"
import type { ComposerAgent, ComposerModel, ComposerModelCatalog } from "@pigcode/ui-composer"
import { pickInstanceId } from "./agent-context"

/** agent.detect 的返回；只关心是否安装。 */
type Detection = Record<string, { installed?: unknown } | undefined>

/** 把协议里的模型条目转成输入框的形状。 */
export function toComposerModel(model: AgentModel): ComposerModel {
  return {
    id: model.id,
    label: model.displayName,
    ...(model.description ? { description: model.description } : {}),
    isDefault: model.isDefault,
    efforts: model.efforts,
    ...(model.custom ? { custom: true } : {}),
  }
}

/** 把一个 Agent 的实例摊平成选择器的选项；停用的实例、停用或没有注册的 Agent 都不列出。 */
export function toComposerAgents(list: AgentList): ComposerAgent[] {
  return list.agents
    .filter((agent) => agent.enabled && agent.registered)
    .flatMap((agent) =>
      agent.instances
        .filter((instance) => instance.enabled)
        .map((instance) => ({
          id: instance.instanceId,
          agentId: agent.agentId,
          label: instance.isDefault ? agent.displayName : instance.label,
        })),
    )
}

/**
 * 读取 Agent 实例列表；连上 Host（含重连）与插件启停（revision 变化）后重新读取。
 * 检测失败时都视为可用。
 */
export function useAgents(
  connection: Connection,
  revision: number,
  connected: boolean,
): ComposerAgent[] {
  const [agents, setAgents] = useState<ComposerAgent[]>([])
  useEffect(() => {
    if (!connected) return undefined
    let cancelled = false
    void (connection.call("agent.list", {}) as Promise<AgentList>)
      .then(async (list) => {
        const base = toComposerAgents(list)
        if (!cancelled) setAgents(base)
        const detection = (await connection.call("agent.detect", {})) as Detection
        if (cancelled) return
        setAgents(
          base.map((agent) => {
            const installed = detection[agent.id]?.installed
            return typeof installed === "boolean" ? { ...agent, installed } : agent
          }),
        )
      })
      .catch(() => undefined)
    return () => {
      cancelled = true
    }
  }, [connection, revision, connected])
  return agents
}

/**
 * Agent 实例与 Agent 的对应关系，按实例 id；侧栏会话行上的缩写与子代理标签由它得出。
 * 取自 agent.list，停用或注册失败的 agent 也在里面，和设置页的缩写一致。
 */
export function useInstanceAgents(
  connection: Connection,
  revision: number,
  connected: boolean,
): {
  names: Readonly<Record<string, string>>
  driverOf: Readonly<Record<string, string>>
  features: Readonly<Record<string, AgentFeatures>>
} {
  const [state, setState] = useState<{
    names: Record<string, string>
    driverOf: Record<string, string>
    features: Record<string, AgentFeatures>
  }>({ names: {}, driverOf: {}, features: {} })
  useEffect(() => {
    if (!connected) return undefined
    let cancelled = false
    void (connection.call("agent.list", {}) as Promise<AgentList>)
      .then((list) => {
        if (cancelled) return
        const names: Record<string, string> = {}
        const driverOf: Record<string, string> = {}
        const features: Record<string, AgentFeatures> = {}
        for (const agent of list.agents) {
          if (agent.features) features[agent.agentId] = agent.features
          for (const instance of agent.instances) {
            names[instance.instanceId] = instance.isDefault ? agent.displayName : instance.label
            // 侧栏与标签记的是实例；时间线里的 run.started 记的是 driver。
            driverOf[instance.instanceId] = agent.agentId
          }
        }
        setState({ names, driverOf, features })
      })
      .catch(() => undefined)
    return () => {
      cancelled = true
    }
  }, [connection, revision, connected])
  return state
}

/** 各 agent 的 Agent 功能；子代理标签可能和主会话用不同的 agent，按标签所在会话的实例取。 */
export function useAgentFeatures(
  connection: Connection,
  revision: number,
  connected: boolean,
): Readonly<Record<string, AgentFeatures>> {
  const { features } = useInstanceAgents(connection, revision, connected)
  return features
}

/** 新会话默认使用的实例；新会话草稿没选过时显示它。连上 Host 与插件启停后重新读取。 */
export function useDefaultInstanceId(
  connection: Connection,
  revision: number,
  connected: boolean,
): string | null {
  const [instanceId, setInstanceId] = useState<string | null>(null)
  useEffect(() => {
    if (!connected) return undefined
    let cancelled = false
    void pickInstanceId(connection)
      .then((id) => {
        if (!cancelled) setInstanceId(id)
      })
      .catch(() => undefined)
    return () => {
      cancelled = true
    }
  }, [connection, revision, connected])
  return instanceId
}

/**
 * 按实例懒加载模型目录：选择器展开到某个实例时才读取，读过的结果在本窗口内复用；
 * 插件启停后清空，重新读取。读取失败记为空目录，不反复重试。
 */
export function useModelCatalog(
  connection: Connection,
  revision: number,
  connected: boolean,
): { catalog: ComposerModelCatalog; load: (instanceId: string) => void } {
  const [catalog, setCatalog] = useState<Record<string, readonly ComposerModel[] | undefined>>({})
  const pending = useRef(new Set<string>())
  useEffect(() => {
    pending.current.clear()
    setCatalog({})
  }, [connection, revision, connected])
  const load = useCallback(
    (instanceId: string) => {
      if (!connected || pending.current.has(instanceId)) return
      pending.current.add(instanceId)
      // 只传实例：Host 按实例找到它所属的 Agent，不会把实例 id 当成 driver id。
      void (connection.call("agent.models", { instanceId }) as Promise<AgentModel[]>)
        .then((models) => models.map(toComposerModel))
        .catch((): ComposerModel[] => [])
        .then((models) => setCatalog((current) => ({ ...current, [instanceId]: models })))
    },
    [connection, connected],
  )
  return { catalog, load }
}
