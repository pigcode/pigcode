/** 输入框模型选择器的数据：已注册的 agent、各自的安装状态与按需读取的模型目录。 */
import { useCallback, useEffect, useRef, useState } from "react"
import type { AgentFeatures, AgentList, AgentModel } from "@pigcode/contracts"
import type { Connection } from "@pigcode/client-runtime"
import type { ComposerAgent, ComposerModel, ComposerModelCatalog } from "@pigcode/ui-composer"
import { listRegisteredAgents } from "./agent-context"

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
    defaultEffort: model.defaultEffort,
    ...(model.custom ? { custom: true } : {}),
  }
}

/**
 * 读取 agent 列表；连上 Host（含重连）与插件启停（revision 变化）后重新读取。
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
    void listRegisteredAgents(connection)
      .then(async (registered) => {
        const base = registered.map((agent) => ({ id: agent.id, label: agent.displayName }))
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
 * agent 的显示名，按 agent id；侧栏会话行上的 agent 缩写由它得出。取自 agent.list，停用或注册失败的
 * agent 也在里面，和设置页的缩写一致。连上 Host 与插件启停后重新读取。
 */
export function useAgentNames(
  connection: Connection,
  revision: number,
  connected: boolean,
): Readonly<Record<string, string>> {
  const [names, setNames] = useState<Record<string, string>>({})
  useEffect(() => {
    if (!connected) return undefined
    let cancelled = false
    void (connection.call("agent.list", {}) as Promise<AgentList>)
      .then((list) => {
        if (cancelled) return
        setNames(Object.fromEntries(list.agents.map((agent) => [agent.agentId, agent.displayName])))
      })
      .catch(() => undefined)
    return () => {
      cancelled = true
    }
  }, [connection, revision, connected])
  return names
}

/** 各 agent 的 Agent 功能；子代理标签可能和主会话用不同的 agent，按标签所在会话的 agent 取。 */
export function useAgentFeatures(
  connection: Connection,
  revision: number,
  connected: boolean,
): Readonly<Record<string, AgentFeatures>> {
  const [features, setFeatures] = useState<Record<string, AgentFeatures>>({})
  useEffect(() => {
    if (!connected) return undefined
    let cancelled = false
    void listRegisteredAgents(connection)
      .then((registered) => {
        if (cancelled) return
        setFeatures(Object.fromEntries(registered.map((agent) => [agent.id, agent.features])))
      })
      .catch(() => undefined)
    return () => {
      cancelled = true
    }
  }, [connection, revision, connected])
  return features
}

/**
 * 按 agent 懒加载模型目录：选择器展开到某个 agent 时才读取，读过的结果在本窗口内复用；
 * 插件启停后清空，重新读取。读取失败记为空目录，不反复重试。
 */
export function useModelCatalog(
  connection: Connection,
  revision: number,
  connected: boolean,
): { catalog: ComposerModelCatalog; load: (agentId: string) => void } {
  const [catalog, setCatalog] = useState<Record<string, readonly ComposerModel[] | undefined>>({})
  const pending = useRef(new Set<string>())
  useEffect(() => {
    pending.current.clear()
    setCatalog({})
  }, [connection, revision, connected])
  const load = useCallback(
    (agentId: string) => {
      if (!connected || pending.current.has(agentId)) return
      pending.current.add(agentId)
      void (connection.call("agent.models", { agentId }) as Promise<AgentModel[]>)
        .then((models) => models.map(toComposerModel))
        .catch((): ComposerModel[] => [])
        .then((models) => setCatalog((current) => ({ ...current, [agentId]: models })))
    },
    [connection, connected],
  )
  return { catalog, load }
}
