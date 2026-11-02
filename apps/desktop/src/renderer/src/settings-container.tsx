/** 设置、Agent 与插件容器：从 Host 拉取状态，注入设置视图。 */
import { useCallback, useEffect, useState } from "react"
import type { AgentList, AgentStatus } from "@pigcode/contracts"
import { PluginManagerView, type PluginSummary } from "@pigcode/ui-plugin-manager"
import { AgentsPage, SettingsView } from "@pigcode/ui-settings"
import type { CoreDeps, SettingsSlotProps } from "./app"
import { refreshAgentViews } from "./agent-context"
import { SchedulesContainer } from "./schedules"

/** 插件管理容器：列表来自 Host，安装/启停/卸载后同步刷新 agent 与 client bundle。 */
export function PluginManagerContainer({ deps }: { deps: CoreDeps }) {
  const [plugins, setPlugins] = useState<PluginSummary[]>([])

  const refresh = useCallback(async (): Promise<void> => {
    const list = (await deps.connection.call("plugin.list", {})) as PluginSummary[]
    setPlugins(list)
  }, [deps.connection])

  useEffect(() => {
    void refresh().catch(() => setPlugins([]))
  }, [refresh])

  async function applyAndReload(action: () => Promise<unknown>): Promise<void> {
    await action()
    await refresh()
    await refreshAgentViews(deps)
    await deps.plugins.reload()
  }

  return (
    <PluginManagerView
      plugins={plugins}
      onInstall={(spec) => applyAndReload(() => deps.connection.call("plugin.install", { spec }))}
      onEnable={(id) => applyAndReload(() => deps.connection.call("plugin.enable", { id }))}
      onDisable={(id) => applyAndReload(() => deps.connection.call("plugin.disable", { id }))}
      onUninstall={(id) => applyAndReload(() => deps.connection.call("plugin.uninstall", { id }))}
      onRefresh={() => applyAndReload(async () => undefined)}
      onPickFolder={() => window.pigcodeNative?.pickPath?.("directory") ?? Promise.resolve(null)}
    />
  )
}

/** Agent 页容器：列表与设置来自 agent.list，状态来自只读检测；改动后刷新输入框里的 agent。 */
export function AgentsContainer({ deps }: { deps: CoreDeps }) {
  const [list, setList] = useState<AgentList>({ agents: [], defaultAgentId: null })
  const [statuses, setStatuses] = useState<Record<string, AgentStatus>>({})
  const [detecting, setDetecting] = useState(false)
  const { connection } = deps

  const refresh = useCallback(async (): Promise<void> => {
    setList((await connection.call("agent.list", {})) as AgentList)
  }, [connection])

  const detect = useCallback(
    async (options: { agentId?: string; refresh?: boolean } = {}): Promise<void> => {
      setDetecting(true)
      try {
        const result = (await connection.call("agent.detect", options)) as Record<
          string,
          AgentStatus
        >
        setStatuses((current) => (options.agentId ? { ...current, ...result } : result))
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

  return (
    <AgentsPage
      agents={list.agents}
      defaultAgentId={list.defaultAgentId}
      statuses={statuses}
      detecting={detecting}
      onDetect={() => detect({ refresh: true })}
      onSetEnabled={async (agent, enabled) => {
        if (!agent.pluginId) return
        await connection.call(enabled ? "plugin.enable" : "plugin.disable", { id: agent.pluginId })
        await afterPluginChange()
      }}
      onSaveSettings={async (agent, values) => {
        await connection.call("agent.updateSettings", { agentId: agent.agentId, values })
        await refresh()
        // 新设置可能换了可执行文件或配置目录：重新检测这个 agent，并让输入框重读模型目录。
        await Promise.all([
          detect({ agentId: agent.agentId, refresh: true }),
          refreshAgentViews(deps),
        ])
      }}
      onSetDefault={async (agentId) => {
        await connection.call("agent.setDefault", { agentId })
        await refresh()
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

/** 设置容器：Agent、定时任务与插件分区由各自的容器渲染。 */
export function SettingsContainer({
  deps,
  section,
  appearance,
}: SettingsSlotProps & { deps: CoreDeps }) {
  return (
    <SettingsView
      section={section}
      appearance={appearance}
      agentsPage={<AgentsContainer deps={deps} />}
      pluginManager={<PluginManagerContainer deps={deps} />}
      schedulesPage={<SchedulesContainer deps={deps} />}
    />
  )
}
