/** 输入框模型选择器的数据：已注册的 agent、各自的安装状态与按需读取的模型目录。 */
import { useCallback, useEffect, useRef, useState } from "react"
import type { ProviderCapabilities, ProviderModel } from "@pigcode/contracts"
import type { Connection } from "@pigcode/client-runtime"
import type { ComposerAgent, ComposerModel, ComposerModelCatalog } from "@pigcode/ui-composer"
import { listProviders } from "./providers"

/** provider.detect 的返回；只关心是否安装。 */
type Detection = Record<string, { installed?: unknown } | undefined>

/** 把协议里的模型条目转成输入框的形状。 */
export function toComposerModel(model: ProviderModel): ComposerModel {
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
    void listProviders(connection)
      .then(async (providers) => {
        const base = providers.map((provider) => ({ id: provider.id, label: provider.displayName }))
        if (!cancelled) setAgents(base)
        const detection = (await connection.call("provider.detect", {})) as Detection
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

/** 各 agent 的能力；子代理标签可能和主会话用不同的 agent，按标签所在会话的 agent 取能力。 */
export function useProviderCapabilities(
  connection: Connection,
  revision: number,
  connected: boolean,
): Readonly<Record<string, ProviderCapabilities>> {
  const [capabilities, setCapabilities] = useState<Record<string, ProviderCapabilities>>({})
  useEffect(() => {
    if (!connected) return undefined
    let cancelled = false
    void listProviders(connection)
      .then((providers) => {
        if (cancelled) return
        setCapabilities(
          Object.fromEntries(providers.map((provider) => [provider.id, provider.capabilities])),
        )
      })
      .catch(() => undefined)
    return () => {
      cancelled = true
    }
  }, [connection, revision, connected])
  return capabilities
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
      void (connection.call("provider.models", { providerId: agentId }) as Promise<ProviderModel[]>)
        .then((models) => models.map(toComposerModel))
        .catch((): ComposerModel[] => [])
        .then((models) => setCatalog((current) => ({ ...current, [agentId]: models })))
    },
    [connection, connected],
  )
  return { catalog, load }
}
