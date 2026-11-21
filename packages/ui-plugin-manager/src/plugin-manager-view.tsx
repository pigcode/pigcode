// 插件市场用于浏览与安装。插件管理有独立的工具栏和列表，返回市场时保留来源与搜索词。
import { useEffect, useRef, useState } from "react"
import { Layers, Plus, RefreshCw } from "lucide-react"
import {
  Button,
  InstallDialog,
  PageCrumbs,
  SearchField,
  SegmentedControl,
  useLocale,
} from "@pigcode/ui-primitives"
import { MarketPluginDialog } from "./market-plugin-dialog"
import { AddMarketplaceDialog, PluginAddMenu } from "./marketplace-dialogs"
import {
  MarketplaceSourcesDialog,
  REFRESH_ALL_SOURCES,
  type SourceActions,
} from "./marketplace-sources"
import { PluginDetailsDialog } from "./plugin-details"
import { PluginList, type PluginStatusFilter } from "./plugin-list"
import { OfficialCatalog, PluginMarket, marketKey, type MarketActions } from "./plugin-market"
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
  /** 官方市场和用户添加的市场。 */
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

type Catalog = "public" | "community" | "personal"

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
  const [manageOpen, setManageOpen] = useState(false)
  const managing = !marketEnabled || manageOpen
  const [catalog, setCatalog] = useState<Catalog>("public")
  const [marketQuery, setMarketQuery] = useState("")
  const [installedQuery, setInstalledQuery] = useState("")
  const [filter, setFilter] = useState<PluginStatusFilter>("all")
  const headingRef = useRef<HTMLHeadingElement>(null)
  const focusPageHeading = useRef(false)
  useEffect(() => {
    if (focusPageHeading.current) {
      headingRef.current?.focus()
      focusPageHeading.current = false
    }
  }, [managing])

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
  const [details, setDetails] = useState<{ id: string; confirmUninstall: boolean } | null>(null)
  const [marketDetails, setMarketDetails] = useState<{ market: string; plugin: string } | null>(
    null,
  )
  // 停用的市场源不在插件市场里列出，也不拿来检查更新。
  const enabledMarkets = marketplaces.filter(isMarketEnabled)
  const officialMarket = enabledMarkets.find((market) => market.official)
  const personalMarkets = enabledMarkets.filter((market) => !market.official)
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

  function navigateToManagement(open: boolean): void {
    focusPageHeading.current = true
    setManageOpen(open)
  }

  const openDetails = (id: string, confirmUninstall = false) => {
    setError(null)
    setDetails({ id, confirmUninstall })
  }

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
  const checkUpdates = managing && onRefreshMarketplaces !== undefined && enabledMarkets.length > 0
  const refreshLabel = t(checkUpdates ? "plugins.checkUpdates" : "plugins.refresh")
  const title = t(managing ? "plugins.title" : "plugins.pageTitle")
  const showSearch =
    managing ||
    catalog === "public" ||
    (catalog === "personal" && personalMarkets.length > 0) ||
    (catalog === "community" &&
      officialMarket?.plugins.some((entry) => entry.publisherType === "community"))
  const setQuery = managing ? setInstalledQuery : setMarketQuery
  const update = onUpdate ? (id: string) => void run(id, () => onUpdate(id)) : undefined
  const installFromMarket = (market: string, plugin: string) =>
    onInstallFromMarketplace &&
    void run(marketKey(market, plugin), () => onInstallFromMarketplace(market, plugin))
  const marketActions: MarketActions = {
    pendingKey: pendingId,
    onInstall: installFromMarket,
    onUpdate: (id) => update?.(id),
    onDetails: (market, plugin) => {
      setError(null)
      setMarketDetails({ market, plugin })
    },
  }
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
    <section className="view" aria-label={title}>
      <div className="panel-top">
        <span className="spacer" />
      </div>
      <div className="panel-scroll">
        <div className="page wide plugin-market">
          {marketEnabled && managing ? (
            <PageCrumbs
              back={t("plugins.pageTitle")}
              backLabel={t("plugins.market.back")}
              onBack={() => navigateToManagement(false)}
            />
          ) : null}
          <header className="page-head market-page-head">
            <h1 ref={headingRef} tabIndex={-1}>
              {title}
            </h1>
            <div className="actions">
              <Button
                size={managing ? "lg" : "icon-lg"}
                shape="pill"
                variant={managing ? "secondary" : "ghost"}
                type="button"
                aria-label={refreshLabel}
                title={refreshLabel}
                disabled={refreshing}
                onClick={() =>
                  void run("refresh", async () => {
                    if (!managing || checkUpdates) await onRefreshMarketplaces?.()
                    if (!checkUpdates) await onRefresh()
                  })
                }
              >
                <RefreshCw
                  className={refreshing ? "ic ic-sm spin" : "ic ic-sm"}
                  aria-hidden="true"
                />
                {managing ? refreshLabel : null}
              </Button>
              {!managing ? (
                <Button
                  size="icon-lg"
                  shape="pill"
                  variant="ghost"
                  type="button"
                  aria-label={t("plugins.sources")}
                  title={t("plugins.sources")}
                  onClick={() => setSourcesOpen(true)}
                >
                  <Layers className="ic ic-sm" aria-hidden="true" />
                </Button>
              ) : null}
              {!managing ? (
                <Button
                  size="lg"
                  shape="pill"
                  type="button"
                  onClick={() => navigateToManagement(true)}
                >
                  {t("plugins.title")}
                </Button>
              ) : null}
              {marketEnabled ? (
                <PluginAddMenu
                  onCreatePlugin={onCreatePlugin ? () => void createPlugin() : undefined}
                  onAddMarketplace={() => setAddMarketOpen(true)}
                  onInstall={() => setInstallOpen(true)}
                />
              ) : (
                <Button
                  size="lg"
                  shape="pill"
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
          {!managing || plugins.length > 0 ? (
            <div className="market-toolbar">
              {managing ? (
                <SegmentedControl<PluginStatusFilter>
                  variant="pills"
                  className="market-tabs"
                  aria-label={t("plugins.filter.label")}
                  value={filter}
                  onValueChange={setFilter}
                  options={[
                    { value: "all", label: t("plugins.filter.all") },
                    { value: "enabled", label: t("plugins.enabled") },
                    { value: "disabled", label: t("plugins.disabled") },
                  ]}
                />
              ) : (
                <SegmentedControl<Catalog>
                  variant="pills"
                  className="market-tabs"
                  aria-label={t("plugins.market.sections")}
                  value={catalog}
                  onValueChange={setCatalog}
                  options={[
                    { value: "public", label: t("plugins.market.public") },
                    { value: "community", label: t("plugins.market.community") },
                    { value: "personal", label: t("plugins.market.personal") },
                  ]}
                />
              )}
              {showSearch ? (
                <SearchField
                  size="lg"
                  shape="pill"
                  className="market-search"
                  value={managing ? installedQuery : marketQuery}
                  onValueChange={setQuery}
                  placeholder={t("plugins.search")}
                  clearLabel={t("settings.clear")}
                  onKeyDown={(event) => {
                    if (event.key === "Escape") setQuery("")
                  }}
                />
              ) : null}
            </div>
          ) : null}
          {error && !detailsPlugin && !marketSelection ? (
            <p className="error-text market-error" role="alert">
              {error}
            </p>
          ) : notice ? (
            <p className="market-notice" role="status">
              {notice}
            </p>
          ) : null}
          {managing ? (
            <PluginList
              plugins={plugins}
              marketplaces={marketplaces}
              query={installedQuery}
              filter={filter}
              pendingId={pendingId}
              onInstall={() => setInstallOpen(true)}
              onEnable={(id) => void run(id, () => onEnable(id))}
              onDisable={(id) => void run(id, () => onDisable(id))}
              onDetails={openDetails}
              canUninstall={onUninstall !== undefined}
              onOpenSettings={onOpenSettings}
              onUpdate={update}
              updatable={updatable}
            />
          ) : catalog !== "personal" ? (
            <OfficialCatalog
              market={officialMarket}
              community={catalog === "community"}
              plugins={plugins}
              query={marketQuery}
              onBuiltinDetails={openDetails}
              onBrowsePersonal={() => setCatalog("personal")}
              {...marketActions}
            />
          ) : (
            <PluginMarket
              marketplaces={personalMarkets}
              disabledCount={marketplaces.length - enabledMarkets.length}
              sourceActions={sourceActions}
              plugins={plugins}
              query={marketQuery}
              onAddMarketplace={() => setAddMarketOpen(true)}
              onInstallFromGitHub={() => setInstallOpen(true)}
              onCreatePlugin={onCreatePlugin ? () => void createPlugin() : undefined}
              {...marketActions}
            />
          )}
        </div>
      </div>
      <PluginDetailsDialog
        plugin={detailsPlugin}
        plugins={plugins}
        pending={detailsPlugin !== null && pendingId === detailsPlugin.id}
        actionError={error}
        confirmUninstall={details?.confirmUninstall}
        onClose={() => setDetails(null)}
        onUninstall={onUninstall ? (id: string) => void run(id, () => onUninstall(id)) : undefined}
        onUpdate={update}
      />
      <MarketPluginDialog
        selection={marketSelection}
        actionError={error}
        plugins={plugins}
        pending={
          marketSelection !== null &&
          (pendingId === marketKey(marketSelection.market.id, marketSelection.entry.name) ||
            plugins.some(
              (plugin) => plugin.name === marketSelection.entry.name && plugin.id === pendingId,
            ))
        }
        onClose={() => setMarketDetails(null)}
        onInstall={installFromMarket}
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
          setInstalledQuery("")
          setFilter("all")
          setManageOpen(true)
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
            setMarketQuery("")
            setCatalog("personal")
            setManageOpen(false)
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
