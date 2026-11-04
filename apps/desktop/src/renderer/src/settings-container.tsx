/**
 * 内置设置页的内容：外观页接 App 的外观控制器，Agent 与插件页从 Host 拉取状态。
 * 这个模块在第一次打开设置页时才加载，登记信息在 builtin-settings-pages。
 */
import { useCallback, useContext, useEffect, useMemo, useState, useSyncExternalStore } from "react"
import { useContributionConflicts } from "@pigcode/client-runtime"
import type { AgentList, AgentStatus } from "@pigcode/contracts"
import { PluginManagerView, type PluginSummary } from "@pigcode/ui-plugin-manager"
import { AgentsPage, AppearancePage } from "@pigcode/ui-settings"
import type { CoreDeps } from "./app"
import { refreshAgentViews } from "./agent-context"
import { AppearanceContext } from "./builtin-settings-pages"

export { GeneralPage } from "@pigcode/ui-settings"
export { SchedulesContainer } from "./schedules"

/** 外观页：用 App 持有的外观控制器，改动立即作用到整个窗口。 */
export function AppearanceContainer() {
  return <AppearancePage appearance={useContext(AppearanceContext) ?? undefined} />
}

/**
 * 插件管理容器：列表来自 Host，安装/启停/卸载后同步刷新 agent 与 client bundle。
 * 扩展点注册表里被拒绝的登记、界面代码加载或运行出的错按插件并进对应的行，
 * 和 Host 报的冲突与错误一样显示在状态与详情里。
 */
export function PluginManagerContainer({ deps }: { deps: CoreDeps }) {
  const [hostPlugins, setPlugins] = useState<PluginSummary[]>([])
  const conflicts = useContributionConflicts()
  const clientErrors = useSyncExternalStore(
    deps.plugins.errors.subscribe,
    deps.plugins.errors.get,
    deps.plugins.errors.get,
  )
  const plugins = useMemo(
    () =>
      hostPlugins.map((plugin) => {
        const own = conflicts.filter(
          (conflict) => conflict.rejected.kind === "plugin" && conflict.rejected.id === plugin.id,
        )
        // 窗口里界面代码出的错：加载失败、apply 抛错或命令执行出错。
        const failures = clientErrors.flatMap((error) =>
          error.pluginId === plugin.id ? [{ kind: error.kind, detail: error.detail }] : [],
        )
        if (own.length === 0 && failures.length === 0) return plugin
        return {
          ...plugin,
          ...(own.length > 0
            ? {
                contributionConflicts: own.map(({ point, id, existing }) => ({
                  point,
                  id,
                  owner: existing,
                })),
              }
            : {}),
          ...(failures.length > 0 ? { clientErrors: failures } : {}),
        }
      }),
    [hostPlugins, conflicts, clientErrors],
  )

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
      onRefresh={() => applyAndReload(() => deps.connection.call("plugin.reload", {}))}
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
