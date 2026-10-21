/** 设置与插件容器：从 Host 拉取状态，注入设置视图。 */
import { useCallback, useEffect, useState } from "react"
import type { ProviderCapabilities } from "@pigcode/contracts"
import { PluginManagerView, type PluginSummary } from "@pigcode/ui-plugin-manager"
import { SettingsView, type ProviderDetection, type ProviderStatus } from "@pigcode/ui-settings"
import type { CoreDeps, SettingsSlotProps } from "./app"
import {
  listProviders,
  loadProviderModels,
  toProviderStatus,
  type CodexDetection,
} from "./providers"
import { SchedulesContainer } from "./schedules"

/** 把 unknown 错误转成可展示文本。 */
function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** 插件管理容器：列表来自 Host，安装/启停后同步刷新 provider 与 client bundle。 */
export function PluginManagerContainer({ deps }: { deps: CoreDeps }) {
  const [plugins, setPlugins] = useState<PluginSummary[]>([])

  const refresh = useCallback(async (): Promise<void> => {
    const list = (await deps.connection.call("plugin.list", {})) as PluginSummary[]
    setPlugins(list)
  }, [deps.connection])

  /**
   * 启停插件会改变 provider 集合：重新拉取列表与检测结果，刷新当前线程的能力/模型，
   * 并递增 providerRevision 让线程头菜单重新读取 provider 列表。
   */
  const refreshProviders = useCallback(async (): Promise<void> => {
    try {
      const [providers] = await Promise.all([
        listProviders(deps.connection),
        deps.connection.call("provider.detect", {}),
      ])
      const snapshot = deps.store.getSnapshot()
      const thread = snapshot.threads.find((item) => item.id === snapshot.activeThreadId)
      if (thread) {
        const providerId = thread.lastProviderId ?? thread.defaultProviderId
        deps.store.update({
          providerCapabilities:
            providers.find((provider) => provider.id === providerId)?.capabilities ?? null,
        })
        try {
          await loadProviderModels(deps.connection, deps.store, providerId)
        } catch {
          deps.store.update({ providerModels: [] })
        }
      }
      deps.store.update({ providerRevision: deps.store.getSnapshot().providerRevision + 1 })
    } catch {
      // provider 刷新失败不影响插件操作本身；列表仍会照常刷新。
    }
  }, [deps.connection, deps.store])

  useEffect(() => {
    void refresh().catch(() => setPlugins([]))
  }, [refresh])

  async function applyAndReload(action: () => Promise<unknown>): Promise<void> {
    await action()
    await refresh()
    await refreshProviders()
    await deps.plugins.reload()
  }

  return (
    <PluginManagerView
      plugins={plugins}
      onInstall={(spec) => applyAndReload(() => deps.connection.call("plugin.install", { spec }))}
      onEnable={(id) => applyAndReload(() => deps.connection.call("plugin.enable", { id }))}
      onDisable={(id) => applyAndReload(() => deps.connection.call("plugin.disable", { id }))}
      onRefresh={() => applyAndReload(async () => undefined)}
    />
  )
}

/** 设置容器：插件分区复用同一个插件管理视图。 */
export function SettingsContainer({
  deps,
  section,
  onSection,
  onClose,
  appearance,
}: SettingsSlotProps & { deps: CoreDeps }) {
  const [providers, setProviders] = useState<ProviderStatus[]>([])

  /** 拉取 Claude/Codex 只读检测结果与能力，并刷新模型列表。 */
  const detect = useCallback(async (): Promise<void> => {
    try {
      const [detection, list] = await Promise.all([
        deps.connection.call("provider.detect", {}) as Promise<{
          claude: ProviderDetection
          codex: CodexDetection
        }>,
        listProviders(deps.connection),
      ])
      const capabilityOf = (id: string): ProviderCapabilities | undefined =>
        list.find((provider) => provider.id === id)?.capabilities
      const displayNameOf = (id: string, fallback: string): string =>
        list.find((provider) => provider.id === id)?.displayName ?? fallback

      setProviders([
        toProviderStatus(
          "claude",
          displayNameOf("claude", "Claude Code"),
          detection.claude,
          capabilityOf("claude"),
        ),
        toProviderStatus(
          "codex",
          displayNameOf("codex", "Codex"),
          {
            installed: detection.codex.installed,
            version: detection.codex.version,
            loggedIn: detection.codex.loggedIn,
            authMethod: null,
            command: detection.codex.command,
            error: detection.codex.error,
          },
          capabilityOf("codex"),
        ),
      ])

      // 用当前线程 provider 的模型目录填充 composer 的模型列表。
      const snapshot = deps.store.getSnapshot()
      const thread = snapshot.threads.find((item) => item.id === snapshot.activeThreadId)
      const providerId = thread?.lastProviderId ?? thread?.defaultProviderId
      if (providerId) await loadProviderModels(deps.connection, deps.store, providerId)
    } catch (error) {
      deps.store.update({ error: messageOf(error) })
    }
  }, [deps.connection, deps.store])

  // 进入设置页时检测一次；用户也可以点击按钮重新检测。
  useEffect(() => {
    void detect()
  }, [detect])

  return (
    <SettingsView
      section={section}
      onSection={onSection}
      onClose={onClose}
      appearance={appearance}
      providers={providers}
      onDetect={detect}
      showNav={false}
      pluginManager={<PluginManagerContainer deps={deps} />}
      schedulesPage={<SchedulesContainer deps={deps} />}
    />
  )
}
