// 插件页：标题栏右边是刷新、市场源与「添加」（创建插件、添加插件市场、安装插件），下面是「插件市场 / 已安装」
// 两个分段和搜索框。插件市场按市场分组列出启用的市场源里可以安装的插件；已安装按类型分组，可以启停、更新与卸载。
import { useEffect, useState } from "react"
import { ChevronDown, Download, Layers, Plus, RefreshCw, Sparkles, Store } from "lucide-react"
import {
  Button,
  InstallDialog,
  Menu,
  SearchField,
  SegmentedControl,
  useLocale,
} from "@pigcode/ui-primitives"
import { MarketPluginDialog } from "./market-plugin-dialog"
import { AddMarketplaceDialog } from "./marketplace-dialogs"
import {
  MarketplaceSourcesDialog,
  REFRESH_ALL_SOURCES,
  type SourceActions,
} from "./marketplace-sources"
import { PluginDetailsDialog } from "./plugin-details"
import { PluginList } from "./plugin-list"
import { PluginMarket, marketKey } from "./plugin-market"
import {
  fill,
  isMarketEnabled,
  pluginErrorText,
  updateFor,
  type MarketplaceSummary,
  type PluginSummary,
} from "./plugin-summary"

/** 插件页需要的状态与事件；操作失败时抛错，页面展示原因。 */
export interface PluginManagerViewProps {
  plugins: PluginSummary[]
  /** 已添加的插件市场；给了 onAddMarketplace 才有插件市场。 */
  marketplaces?: MarketplaceSummary[] | undefined
  onInstall: (spec: string) => Promise<void>
  onEnable: (id: string) => Promise<void>
  onDisable: (id: string) => Promise<void>
  /** 卸载用户安装的插件；缺省时没有卸载入口。 */
  onUninstall?: ((id: string) => Promise<void>) | undefined
  onRefresh: () => Promise<void>
  /** 选择本地插件目录；没有时安装对话框不显示「选择文件夹」。 */
  onPickFolder?: (() => Promise<string | null>) | undefined
  /** 打开插件的设置页（卡片上的「打开」）；缺省时不显示「打开」。 */
  onOpenSettings?: ((page: string) => void) | undefined
  onInstallFromMarketplace?: ((marketplace: string, plugin: string) => Promise<void>) | undefined
  /** 按来源重新安装用户安装的插件。 */
  onUpdate?: ((id: string) => Promise<void>) | undefined
  onAddMarketplace?: ((source: string) => Promise<void>) | undefined
  /** 刷新一个市场；不给 id 时刷新全部启用的市场。 */
  onRefreshMarketplaces?: ((id?: string) => Promise<void>) | undefined
  /** 启用或停用市场源；缺省时市场源管理里没有开关。 */
  onSetMarketplaceEnabled?: ((id: string, enabled: boolean) => Promise<void>) | undefined
  onRemoveMarketplace?: ((id: string) => Promise<void>) | undefined
  /** 在文件夹中显示本地市场源。 */
  onRevealPath?: ((path: string) => void) | undefined
  /** 让 agent 创建插件：进入新会话草稿，输入框里预填好指南；没有项目时返回 false。 */
  onCreatePlugin?: (() => Promise<boolean>) | undefined
  /** 用系统浏览器打开网址（插件主页）。 */
  onOpenExternal?: ((url: string) => void) | undefined
}

type Segment = "market" | "installed"

/** 渲染插件页。 */
export function PluginManagerView({
  plugins,
  marketplaces = [],
  onInstall,
  onEnable,
  onDisable,
  onUninstall,
  onRefresh,
  onPickFolder,
  onOpenSettings,
  onInstallFromMarketplace,
  onUpdate,
  onAddMarketplace,
  onRefreshMarketplaces,
  onSetMarketplaceEnabled,
  onRemoveMarketplace,
  onRevealPath,
  onCreatePlugin,
  onOpenExternal,
}: PluginManagerViewProps) {
  const { t } = useLocale()
  const marketEnabled = onAddMarketplace !== undefined
  const [chosenSegment, setSegment] = useState<Segment | null>(null)
  const [pendingId, setPendingId] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  // 一闪而过的提示，例如复制了来源地址。
  const [notice, setNotice] = useState<string | null>(null)
  useEffect(() => {
    if (!notice) return undefined
    const timer = setTimeout(() => setNotice(null), 2400)
    return () => clearTimeout(timer)
  }, [notice])
  const [installOpen, setInstallOpen] = useState(false)
  const [addMarketOpen, setAddMarketOpen] = useState(false)
  const [sourcesOpen, setSourcesOpen] = useState(false)
  const [query, setQuery] = useState("")
  const [details, setDetails] = useState<{ id: string; confirmUninstall: boolean } | null>(null)
  const [marketDetails, setMarketDetails] = useState<{ market: string; plugin: string } | null>(
    null,
  )
  // 停用的市场源不在插件市场里列出，也不拿来检查更新。
  const enabledMarkets = marketplaces.filter(isMarketEnabled)
  // 没选过分段时：有市场就看市场，没有就看已安装的插件。
  const segment: Segment =
    chosenSegment ?? (marketEnabled && marketplaces.length > 0 ? "market" : "installed")
  // 详情跟着列表走：插件卸载后从列表里消失，对话框随之关闭。
  const detailsPlugin = details
    ? (plugins.find((plugin) => plugin.id === details.id) ?? null)
    : null
  const selectedMarket = marketDetails
    ? marketplaces.find((market) => market.id === marketDetails.market)
    : undefined
  const selectedEntry = selectedMarket?.plugins.find(
    (entry) => entry.name === marketDetails?.plugin,
  )
  const marketSelection =
    selectedMarket && selectedEntry ? { market: selectedMarket, entry: selectedEntry } : null
  // 市场里有新版本的已安装插件。
  const updatable = new Set(
    enabledMarkets.flatMap((market) =>
      market.plugins.flatMap((entry) => {
        const installed = plugins.find((plugin) => plugin.name === entry.name)
        return installed && updateFor(installed, market, entry) ? [installed.id] : []
      }),
    ),
  )

  async function run(id: string, action: () => Promise<void>): Promise<boolean> {
    setPendingId(id)
    setError(null)
    try {
      await action()
      return true
    } catch (reason) {
      setError(fill(t("plugins.failed"), { reason: pluginErrorText(reason, t) }))
      return false
    } finally {
      setPendingId(null)
    }
  }

  async function createPlugin(): Promise<void> {
    if (!onCreatePlugin) return
    setError(null)
    const started = await onCreatePlugin().catch((reason: unknown) => {
      setError(fill(t("plugins.failed"), { reason: pluginErrorText(reason, t) }))
      return true
    })
    if (!started) setError(t("plugins.creator.noProject"))
  }

  const refreshing = pendingId === "refresh"
  const update = onUpdate ? (id: string) => void run(id, () => onUpdate(id)) : undefined
  const refreshMarket = onRefreshMarketplaces
    ? (id: string) => void run(id, () => onRefreshMarketplaces(id))
    : undefined
  const setMarketEnabled = onSetMarketplaceEnabled
    ? (id: string, enabled: boolean) => void run(id, () => onSetMarketplaceEnabled(id, enabled))
    : undefined
  const sourceActions: SourceActions = {
    onRefresh: refreshMarket,
    onSetEnabled: setMarketEnabled,
    onOpenExternal,
    onRevealPath,
    onCopied: () => setNotice(t("plugins.sourcesDialog.copied")),
    onManage: () => setSourcesOpen(true),
  }

  return (
    <section className="view" aria-label={t("plugins.title")}>
      <div className="panel-top">
        <span className="spacer" />
      </div>
      <div className="panel-scroll">
        <div className="page wide plugin-market">
          <header className="page-head">
            <div>
              <h1>{t("plugins.pageTitle")}</h1>
              <p className="sub">{t("plugins.sub")}</p>
            </div>
            <div className="actions">
              <Button
                size="sm"
                variant="ghost"
                type="button"
                disabled={refreshing}
                onClick={() =>
                  void run("refresh", async () => {
                    if (segment === "market" && onRefreshMarketplaces) await onRefreshMarketplaces()
                    await onRefresh()
                  })
                }
              >
                <RefreshCw
                  className={refreshing ? "ic ic-sm spin" : "ic ic-sm"}
                  aria-hidden="true"
                />
                {t("plugins.refresh")}
              </Button>
              {marketEnabled ? (
                <Button
                  size="sm"
                  variant="ghost"
                  type="button"
                  className="market-sources-btn"
                  onClick={() => setSourcesOpen(true)}
                >
                  <Layers className="ic ic-sm" aria-hidden="true" />
                  {t("plugins.sources")}
                  {marketplaces.length > 0 ? (
                    <span className="market-sources-count" aria-hidden="true">
                      {marketplaces.length}
                    </span>
                  ) : null}
                </Button>
              ) : null}
              {marketEnabled ? (
                <Menu.Root>
                  <Menu.Trigger className="btn btn-primary btn-sm market-add">
                    <Plus className="ic ic-sm" aria-hidden="true" />
                    {t("plugins.add")}
                    <ChevronDown className="ic ic-sm" aria-hidden="true" />
                  </Menu.Trigger>
                  <Menu.Portal>
                    <Menu.Positioner side="bottom" align="end" sideOffset={4}>
                      <Menu.Popup className="market-add-menu">
                        {onCreatePlugin ? (
                          <Menu.Item onClick={() => void createPlugin()}>
                            <Sparkles className="ic" aria-hidden="true" />
                            <span className="grow">
                              {t("plugins.add.create")}
                              <span className="menu-item-desc">{t("plugins.add.createHint")}</span>
                            </span>
                          </Menu.Item>
                        ) : null}
                        <Menu.Item onClick={() => setAddMarketOpen(true)}>
                          <Store className="ic" aria-hidden="true" />
                          <span className="grow">
                            {t("plugins.add.marketplace")}
                            <span className="menu-item-desc">
                              {t("plugins.add.marketplaceHint")}
                            </span>
                          </span>
                        </Menu.Item>
                        <Menu.Item onClick={() => setInstallOpen(true)}>
                          <Download className="ic" aria-hidden="true" />
                          <span className="grow">
                            {t("plugins.add.install")}
                            <span className="menu-item-desc">{t("plugins.add.installHint")}</span>
                          </span>
                        </Menu.Item>
                      </Menu.Popup>
                    </Menu.Positioner>
                  </Menu.Portal>
                </Menu.Root>
              ) : (
                <Button
                  size="sm"
                  variant="primary"
                  type="button"
                  onClick={() => setInstallOpen(true)}
                >
                  <Plus className="ic ic-sm" aria-hidden="true" />
                  {t("plugins.install")}
                </Button>
              )}
            </div>
          </header>
          <div className="market-toolbar">
            {marketEnabled ? (
              <SegmentedControl<Segment>
                aria-label={t("plugins.segment")}
                value={segment}
                onValueChange={setSegment}
                options={[
                  { value: "market", label: t("plugins.segment.market") },
                  {
                    value: "installed",
                    label: fill(t("plugins.segment.installedCount"), {
                      count: String(plugins.length),
                    }),
                  },
                ]}
              />
            ) : null}
            {plugins.length > 0 || marketplaces.length > 0 ? (
              <SearchField
                className="market-search"
                value={query}
                onValueChange={setQuery}
                placeholder={t("plugins.search")}
                clearLabel={t("settings.clear")}
                onKeyDown={(event) => {
                  if (event.key === "Escape") setQuery("")
                }}
              />
            ) : null}
          </div>
          {error ? (
            <p className="error-text market-error" role="alert">
              {error}
            </p>
          ) : notice ? (
            <p className="market-notice" role="status">
              {notice}
            </p>
          ) : null}
          {segment === "market" ? (
            <PluginMarket
              marketplaces={enabledMarkets}
              disabledCount={marketplaces.length - enabledMarkets.length}
              sourceActions={sourceActions}
              plugins={plugins}
              query={query}
              pendingKey={pendingId}
              onInstall={(market, plugin) =>
                onInstallFromMarketplace &&
                void run(marketKey(market, plugin), () => onInstallFromMarketplace(market, plugin))
              }
              onUpdate={(id) => update?.(id)}
              onDetails={(market, plugin) => setMarketDetails({ market, plugin })}
              onAddMarketplace={() => setAddMarketOpen(true)}
              onInstallFromGitHub={() => setInstallOpen(true)}
              onCreatePlugin={onCreatePlugin ? () => void createPlugin() : undefined}
            />
          ) : (
            <PluginList
              plugins={plugins}
              query={query}
              pendingId={pendingId}
              onInstall={() => setInstallOpen(true)}
              onEnable={(id) => void run(id, () => onEnable(id))}
              onDisable={(id) => void run(id, () => onDisable(id))}
              onDetails={(id, confirmUninstall = false) => setDetails({ id, confirmUninstall })}
              canUninstall={onUninstall !== undefined}
              onOpenSettings={onOpenSettings}
              onUpdate={update}
              updatable={updatable}
            />
          )}
        </div>
      </div>
      <PluginDetailsDialog
        plugin={detailsPlugin}
        plugins={plugins}
        pending={detailsPlugin !== null && pendingId === detailsPlugin.id}
        confirmUninstall={details?.confirmUninstall}
        onClose={() => setDetails(null)}
        onUninstall={onUninstall ? (id: string) => void run(id, () => onUninstall(id)) : undefined}
        onUpdate={update}
      />
      <MarketPluginDialog
        selection={marketSelection}
        plugins={plugins}
        pending={
          marketSelection !== null &&
          (pendingId === marketKey(marketSelection.market.id, marketSelection.entry.name) ||
            plugins.some(
              (plugin) => plugin.name === marketSelection.entry.name && plugin.id === pendingId,
            ))
        }
        onClose={() => setMarketDetails(null)}
        onInstall={(market, plugin) =>
          onInstallFromMarketplace &&
          void run(marketKey(market, plugin), () => onInstallFromMarketplace(market, plugin))
        }
        onUpdate={(id) => update?.(id)}
        onOpenExternal={onOpenExternal}
      />
      <InstallDialog
        open={installOpen}
        onOpenChange={setInstallOpen}
        onInstall={async (spec) => {
          try {
            await onInstall(spec)
          } catch (reason) {
            throw new Error(pluginErrorText(reason, t))
          }
          setSegment("installed")
        }}
        inputId="plugin-install-spec"
        labels={{
          close: t("common.close"),
          title: t("plugins.install.title"),
          description: t("plugins.install.description"),
          spec: t("plugins.installSpec"),
          placeholder: t("plugins.installSpecPlaceholder"),
          chooseFolder: t("plugins.chooseFolder"),
          trust: t("plugins.trustWarning"),
          cancel: t("common.cancel"),
          submit: t("plugins.install.submit"),
          installing: t("plugins.installing"),
          failed: t("plugins.failed"),
        }}
        onPickFolder={onPickFolder}
      />
      {onAddMarketplace ? (
        <AddMarketplaceDialog
          open={addMarketOpen}
          onOpenChange={setAddMarketOpen}
          onAdd={async (source) => {
            await onAddMarketplace(source)
            setSegment("market")
          }}
          onPickFolder={onPickFolder}
        />
      ) : null}
      {marketEnabled ? (
        <MarketplaceSourcesDialog
          open={sourcesOpen}
          onOpenChange={setSourcesOpen}
          marketplaces={marketplaces}
          plugins={plugins}
          pendingId={pendingId}
          onRefresh={(id) => refreshMarket?.(id)}
          onRefreshAll={
            onRefreshMarketplaces
              ? () => void run(REFRESH_ALL_SOURCES, () => onRefreshMarketplaces())
              : undefined
          }
          onSetEnabled={setMarketEnabled}
          onRemove={(id) => onRemoveMarketplace && void run(id, () => onRemoveMarketplace(id))}
          onAdd={() => {
            setSourcesOpen(false)
            setAddMarketOpen(true)
          }}
          onOpenExternal={onOpenExternal}
          onRevealPath={onRevealPath}
        />
      ) : null}
    </section>
  )
}
