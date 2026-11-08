/**
 * 内置设置页的内容：外观页接 App 的外观控制器，Agent 页从 Host 拉取状态。
 * 这个模块在第一次打开设置页时才加载，登记信息在 builtin-settings-pages。
 */
import { useCallback, useContext, useEffect, useState } from "react"
import type { AgentInstance, AgentList, AgentStatus } from "@pigcode/contracts"
import { AgentsPage, AppearancePage } from "@pigcode/ui-settings"
import type { CoreDeps } from "./app"
import { refreshAgentViews } from "./agent-context"
import { AppearanceContext } from "./builtin-settings-pages"

export { GeneralPage } from "@pigcode/ui-settings"

/** 外观页：用 App 持有的外观控制器，改动立即作用到整个窗口。 */
export function AppearanceContainer() {
  return <AppearancePage appearance={useContext(AppearanceContext) ?? undefined} />
}

/** Agent 页容器：列表与设置来自 agent.list，状态来自只读检测；改动后刷新输入框里的实例。 */
export function AgentsContainer({ deps }: { deps: CoreDeps }) {
  const [list, setList] = useState<AgentList>({
    agents: [],
    defaultAgentId: null,
    defaultInstanceId: null,
  })
  const [statuses, setStatuses] = useState<Record<string, AgentStatus>>({})
  const [detecting, setDetecting] = useState(false)
  const { connection } = deps

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

  useEffect(() => {
    void refresh().catch((error: unknown) =>
      deps.store.update({ error: error instanceof Error ? error.message : String(error) }),
    )
    void detect().catch(() => undefined)
  }, [refresh, detect, deps.store])

  /** 插件集合变了：重读列表与检测，通知输入框与线程头，并重新加载 UI 插件。 */
  async function afterPluginChange(): Promise<void> {
    await refresh()
    setStatuses({})
    await Promise.all([detect(), refreshAgentViews(deps), deps.plugins.reload()])
  }

  /** 改完一个实例：刷新列表、重新检测它，并让输入框重读模型目录（可执行文件或账号可能换了）。 */
  async function afterInstanceChange(instanceId: string, agentId?: string): Promise<void> {
    await refresh()
    await Promise.all([
      detect({ ...(agentId ? { agentId } : {}), instanceId, refresh: true }),
      refreshAgentViews(deps),
    ])
  }

  return (
    <AgentsPage
      agents={list.agents}
      defaultAgentId={list.defaultAgentId}
      defaultInstanceId={list.defaultInstanceId}
      statuses={statuses}
      detecting={detecting}
      onDetect={() => detect({ refresh: true })}
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
      onCreateInstance={async (agent, label, copyFrom) => {
        const created = (await connection.call("agent.createInstance", {
          agentId: agent.agentId,
          label,
          ...(copyFrom ? { copyFrom } : {}),
        })) as AgentInstance
        await afterInstanceChange(created.instanceId, agent.agentId)
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
      onInstall={async (spec) => {
        await connection.call("plugin.install", { spec })
        await afterPluginChange()
      }}
      onUninstall={async (agent) => {
        if (!agent.pluginId) return
        await connection.call("plugin.uninstall", { id: agent.pluginId })
        await afterPluginChange()
      }}
      onPickPath={(kind) => window.pigcodeNative?.pickPath?.(kind) ?? Promise.resolve(null)}
      onOpenExternal={(url) => void window.pigcodeNative?.openExternal?.(url)}
    />
  )
}
