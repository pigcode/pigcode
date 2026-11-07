/**
 * 插件页容器：插件列表与插件市场来自 Host，安装/启停/更新/卸载后同步刷新 agent 与 client bundle。
 * 扩展点注册表里被拒绝的登记、界面代码加载或运行出的错按插件并进对应的卡片，
 * 和 Host 报的冲突与错误一样显示在状态与详情里。卡片上「打开」去插件自己的设置页，
 * Agent 插件没有自己的设置页时去 Agent 页。「创建插件」进入新会话草稿，输入框里预填好指南。
 * 这个模块在第一次打开插件页时才加载（workspace-pages）。
 */
import { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from "react"
import { useContributionConflicts, useContributions } from "@pigcode/client-runtime"
import { prefillComposer } from "@pigcode/ui-composer"
import { useLocale } from "@pigcode/ui-primitives"
import {
  PluginManagerView,
  pluginCreatorDraft,
  type MarketplaceSummary,
  type PluginSummary,
} from "@pigcode/ui-plugin-manager"
import type { CoreDeps } from "./app"
import { refreshAgentViews } from "./agent-context"

/** Agent 插件的设置都在内置的 Agent 页里。 */
const AGENTS_PAGE = "agents"

export function PluginManagerContainer({
  deps,
  onOpenSettings,
  onStartDraft,
}: {
  deps: CoreDeps
  onOpenSettings: (page: string) => void
  onStartDraft: (prefill: (draftKey: string) => void) => boolean
}) {
  const { t, locale } = useLocale()
  const [hostPlugins, setPlugins] = useState<PluginSummary[]>([])
  const [marketplaces, setMarketplaces] = useState<MarketplaceSummary[]>([])
  const conflicts = useContributionConflicts()
  const settingsPages = useContributions("settingsPage")
  const clientErrors = useSyncExternalStore(
    deps.plugins.errors.subscribe,
    deps.plugins.errors.get,
    deps.plugins.errors.get,
  )
  const plugins = useMemo(() => {
    const agentsPage = settingsPages.some((page) => page.id === AGENTS_PAGE)
    return hostPlugins.map((plugin) => {
      const own = conflicts.filter(
        (conflict) => conflict.rejected.kind === "plugin" && conflict.rejected.id === plugin.id,
      )
      // 窗口里界面代码出的错：加载失败、apply 抛错或命令执行出错。
      const failures = clientErrors.flatMap((error) =>
        error.pluginId === plugin.id ? [{ kind: error.kind, detail: error.detail }] : [],
      )
      const ownPage = settingsPages.find(
        (page) => page.owner.kind === "plugin" && page.owner.id === plugin.id,
      )?.id
      const settingsPage = ownPage ?? (plugin.kind === "agent" && agentsPage ? AGENTS_PAGE : null)
      if (own.length === 0 && failures.length === 0 && settingsPage === null) return plugin
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
        ...(settingsPage !== null ? { settingsPage } : {}),
      }
    })
  }, [hostPlugins, conflicts, clientErrors, settingsPages])

  const refresh = useCallback(async (): Promise<void> => {
    const list = (await deps.connection.call("plugin.list", {})) as PluginSummary[]
    setPlugins(list)
  }, [deps.connection])

  const refreshMarketplaces = useCallback(async (): Promise<void> => {
    setMarketplaces((await deps.connection.call("marketplace.list", {})) as MarketplaceSummary[])
  }, [deps.connection])

  useEffect(() => {
    void refresh().catch(() => setPlugins([]))
    void refreshMarketplaces().catch(() => setMarketplaces([]))
  }, [refresh, refreshMarketplaces])

  async function applyAndReload(action: () => Promise<unknown>): Promise<void> {
    await action()
    await refresh()
    await refreshAgentViews(deps)
    await deps.plugins.reload()
  }

  /** 改了市场：重新读一遍市场列表。 */
  async function changeMarketplaces(action: () => Promise<unknown>): Promise<void> {
    try {
      await action()
    } finally {
      await refreshMarketplaces()
    }
  }

  return (
    <PluginManagerView
      plugins={plugins}
      marketplaces={marketplaces}
      onInstall={(spec) => applyAndReload(() => deps.connection.call("plugin.install", { spec }))}
      onEnable={(id) => applyAndReload(() => deps.connection.call("plugin.enable", { id }))}
      onDisable={(id) => applyAndReload(() => deps.connection.call("plugin.disable", { id }))}
      onUninstall={(id) => applyAndReload(() => deps.connection.call("plugin.uninstall", { id }))}
      onRefresh={() => applyAndReload(() => deps.connection.call("plugin.reload", {}))}
      onPickFolder={() => window.pigcodeNative?.pickPath?.("directory") ?? Promise.resolve(null)}
      onOpenSettings={onOpenSettings}
      onInstallFromMarketplace={(marketplace, name) =>
        applyAndReload(() =>
          deps.connection.call("plugin.installFromMarketplace", { marketplace, name }),
        )
      }
      onUpdate={(id) =>
        changeMarketplaces(() =>
          applyAndReload(() => deps.connection.call("plugin.update", { id })),
        )
      }
      onAddMarketplace={(source) =>
        changeMarketplaces(() => deps.connection.call("marketplace.add", { source }))
      }
      onRefreshMarketplaces={(id) =>
        changeMarketplaces(() => deps.connection.call("marketplace.refresh", id ? { id } : {}))
      }
      onSetMarketplaceEnabled={(id, enabled) =>
        changeMarketplaces(() => deps.connection.call("marketplace.setEnabled", { id, enabled }))
      }
      onRemoveMarketplace={(id) =>
        changeMarketplaces(() => deps.connection.call("marketplace.remove", { id }))
      }
      onRevealPath={(path) => void window.pigcodeNative?.revealPath?.(path).catch(() => undefined)}
      onCreatePlugin={async () => {
        const draft = pluginCreatorDraft(t, locale)
        return onStartDraft((key) =>
          prefillComposer(key, { text: draft.text, contexts: [draft.context] }),
        )
      }}
      onOpenExternal={(url) => void window.pigcodeNative?.openExternal?.(url)}
    />
  )
}
