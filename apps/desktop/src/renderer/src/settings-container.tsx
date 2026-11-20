/**
 * 内置设置页的内容：外观页接 App 的外观控制器，Agent 页从 Host 拉取状态。
 * 这个模块在第一次打开设置页时才加载，登记信息在 builtin-settings-pages。
 */
import { useCallback, useContext, useEffect, useState } from "react"
import type {
  AcpRegistryEntry,
  AgentAuthAction,
  AgentAuthState,
  AgentInstance,
  AgentList,
  AgentStatus,
} from "@pigcode/contracts"
import { useAppStore } from "@pigcode/client-runtime"
import {
  AgentsPage,
  AppearancePage,
  GeneralPage as GeneralSettingsPage,
} from "@pigcode/ui-settings"
import type { CoreDeps } from "./app"
import { refreshAgentViews } from "./agent-context"
import { useModelCatalog } from "./agents"
import { AppearanceContext } from "./builtin-settings-pages"
import { useUpdateCenter } from "./update-center"

export function GeneralPage() {
  const updates = useUpdateCenter()
  return <GeneralSettingsPage onShowUpdates={() => updates.show()} />
}

/** 外观页：用 App 持有的外观控制器，改动立即作用到整个窗口。 */
export function AppearanceContainer() {
  return <AppearancePage appearance={useContext(AppearanceContext) ?? undefined} />
}

/** Agent 页容器：列表与设置来自 agent.list，状态来自只读检测；改动后刷新输入框里的实例。 */
export function AgentsContainer({ deps }: { deps: CoreDeps }) {
  const updates = useUpdateCenter()
  const cliUpdates = updates.cli
  const [list, setList] = useState<AgentList>({
    agents: [],
    defaultAgentId: null,
    defaultInstanceId: null,
  })
  const [statuses, setStatuses] = useState<Record<string, AgentStatus>>({})
  const [detecting, setDetecting] = useState(false)
  const { connection } = deps
  // 展开实例时读它的模型目录；改完设置（自定义模型、可执行文件）后换一个版本号重读。
  const [modelRevision, setModelRevision] = useState(0)
  const appState = useAppStore(deps.store)
  const connected = appState.status === "connected"
  const { catalog, load } = useModelCatalog(
    connection,
    modelRevision + appState.agentRevision,
    connected,
  )

  const refresh = useCallback(async (): Promise<void> => {
    setList((await connection.call("agent.list", {})) as AgentList)
  }, [connection])

  const detect = useCallback(
    async (options: { agentId?: string; instanceId?: string; refresh?: boolean } = {}) => {
      setDetecting(true)
      try {
        const result = (await connection.call("agent.detect", options)) as Record<
          string,
          AgentStatus
        >
        setStatuses((current) =>
          options.agentId || options.instanceId ? { ...current, ...result } : result,
        )
      } finally {
        setDetecting(false)
      }
    },
    [connection],
  )

  const auth = useCallback(
    async (instanceId: string, request: AgentAuthAction) =>
      (await connection.call("agent.auth", { instanceId, request })) as AgentAuthState,
    [connection],
  )
  const loadAcpRegistry = useCallback(
    () => connection.call("agent.acpRegistry", {}) as Promise<AcpRegistryEntry[]>,
    [connection],
  )
  const prepareAcpRegistry = useCallback(
    (registryId: string) =>
      connection.call("agent.prepareAcpRegistry", { registryId }) as Promise<AcpRegistryEntry>,
    [connection],
  )
  const accountChanged = useCallback(
    (instanceId: string) => {
      void detect({ instanceId, refresh: true }).catch(() => undefined)
      void refreshAgentViews(deps)
    },
    [detect, deps],
  )

  useEffect(() => {
    if (!connected) return
    void refresh().catch((error: unknown) =>
      deps.store.update({ error: error instanceof Error ? error.message : String(error) }),
    )
    void detect().catch(() => undefined)
  }, [connected, refresh, detect, deps.store, appState.agentRevision])

  /** 插件集合变了：重读列表与检测，通知输入框与线程头，并重新加载 UI 插件。 */
  async function afterPluginChange(): Promise<void> {
    await refresh()
    setStatuses({})
    setModelRevision((value) => value + 1)
    await Promise.all([detect(), refreshAgentViews(deps), deps.plugins.reload()])
    if (Object.keys(cliUpdates.states).length > 0) await cliUpdates.check()
  }

  /** 重新检测实例，并让输入框重读模型目录（可执行文件或账号可能换了）。 */
  async function refreshInstanceRuntime(instanceId: string, agentId?: string): Promise<void> {
    setModelRevision((value) => value + 1)
    await Promise.all([
      detect({ ...(agentId ? { agentId } : {}), instanceId, refresh: true }),
      refreshAgentViews(deps),
    ])
    if (cliUpdates.states[instanceId]) await cliUpdates.check(instanceId)
  }

  async function afterInstanceChange(instanceId: string, agentId?: string): Promise<void> {
    await refresh()
    await refreshInstanceRuntime(instanceId, agentId)
  }

  return (
    <AgentsPage
      cliUpdates={cliUpdates.states}
      checkingCliUpdates={cliUpdates.checking}
      onCheckCliUpdates={cliUpdates.check}
      onUpdateCli={cliUpdates.update}
      registry={{ list: loadAcpRegistry, prepare: prepareAcpRegistry }}
      setupActions={{
        auth,
        accountChanged,
        cancelInstall: async (instanceId) => {
          await connection.call("agent.cancelCliUpdate", { instanceId })
        },
        removeInstall: async (instanceId) => {
          await connection.call("agent.removeCli", { instanceId })
          await cliUpdates.check()
          await detect({ refresh: true })
          await refreshAgentViews(deps)
        },
      }}
      onShowUpdates={updates.show}
      agents={list.agents}
      defaultAgentId={list.defaultAgentId}
      defaultInstanceId={list.defaultInstanceId}
      statuses={statuses}
      detecting={detecting}
      models={catalog}
      onLoadModels={load}
      onDetect={async () => {
        await detect({ refresh: true })
        await refreshAgentViews(deps)
      }}
      onSetEnabled={async (agent, enabled) => {
        if (!agent.pluginId) return
        await connection.call(enabled ? "plugin.enable" : "plugin.disable", { id: agent.pluginId })
        await afterPluginChange()
      }}
      onSaveSettings={async (agent, instance, values) => {
        await connection.call("agent.updateSettings", {
          agentId: agent.agentId,
          instanceId: instance.instanceId,
          values,
        })
        await afterInstanceChange(instance.instanceId, agent.agentId)
      }}
      onSetDefault={async (instanceId) => {
        await connection.call("agent.setDefault", {
          agentId: instanceId
            ? (list.agents.find((agent) =>
                agent.instances.some((item) => item.instanceId === instanceId),
              )?.agentId ?? instanceId)
            : null,
          instanceId,
        })
        await refresh()
      }}
      onCreateInstance={async (draft) => {
        const created = (await connection.call("agent.createInstance", draft)) as AgentInstance
        // 保存已完成，CLI 的检测或目录刷新不应让创建向导继续等待。
        await refresh().catch((error: unknown) =>
          deps.store.update({ error: error instanceof Error ? error.message : String(error) }),
        )
        void refreshInstanceRuntime(created.instanceId, created.agentId).catch(() => undefined)
        return created.instanceId
      }}
      onUpdateInstance={async (agent, instanceId, patch) => {
        await connection.call("agent.updateInstance", { instanceId, patch })
        await afterInstanceChange(instanceId, agent.agentId)
      }}
      onRemoveInstance={async (agent, instanceId) => {
        await connection.call("agent.removeInstance", { instanceId })
        await refresh()
        await refreshAgentViews(deps)
      }}
      onPickPath={(kind) => window.pigcodeNative?.pickPath?.(kind) ?? Promise.resolve(null)}
      onOpenExternal={(url) => window.pigcodeNative?.openExternal?.(url)}
    />
  )
}
