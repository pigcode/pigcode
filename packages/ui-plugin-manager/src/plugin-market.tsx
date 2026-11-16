// 官方目录的公开与社区按用途分组。个人目录按市场源分组。
import { useId, useState } from "react"
import {
  Check,
  Download,
  GitBranch,
  Package,
  PowerOff,
  Search,
  Sparkles,
  Store,
  TriangleAlert,
  Users,
} from "lucide-react"
import {
  Button,
  EmptyState,
  EntityAvatar,
  formatRelativeTime,
  useLocale,
  type Locale,
  type MessageKey,
} from "@pigcode/ui-primitives"
import {
  KIND_ORDER,
  descriptionOf,
  fill,
  kindKeys,
  matchesPlugin,
  marketplacePluginDescription,
  marketplacePluginName,
  sourceTypeKeys,
  updateFor,
  type MarketplacePlugin,
  type MarketplaceSummary,
  type PluginSummary,
} from "./plugin-summary"
import { InstalledPluginIcon } from "./installed-plugin-icon"
import { SourceMenu, type SourceActions } from "./marketplace-sources"

function BuiltinMarket({
  plugins,
  onDetails,
}: {
  plugins: readonly PluginSummary[]
  onDetails: (id: string) => void
}) {
  const { t, locale } = useLocale()
  return (
    <>
      {KIND_ORDER.map((kind) => {
        const group = plugins.filter((plugin) => plugin.kind === kind)
        const title = t(kindKeys[kind])
        return group.length > 0 ? (
          <section key={kind} className="market-section" aria-label={title}>
            <h2 className="market-section-title">{title}</h2>
            <div className="market-grid">
              {group.map((plugin) => {
                const name = plugin.displayName ?? plugin.name
                const description = descriptionOf(plugin, locale)
                return (
                  <div key={plugin.id} className="market-tile">
                    <button
                      type="button"
                      className="market-tile-main"
                      aria-label={fill(t("plugins.expand"), { plugin: name })}
                      onClick={() => onDetails(plugin.id)}
                    >
                      <InstalledPluginIcon plugin={plugin} />
                      <span className="market-tile-text">
                        <span className="market-tile-name truncate">{name}</span>
                        {description ? (
                          <span className="market-tile-desc truncate" title={description}>
                            {description}
                          </span>
                        ) : null}
                      </span>
                    </button>
                    <span className="market-installed">{t("plugins.builtin")}</span>
                  </div>
                )
              })}
            </div>
          </section>
        ) : null
      })}
    </>
  )
}

/** 插件图标：市场给了图片就用图片，读不到时退回按名字生成的头像。 */
export function PluginIcon({
  id,
  name,
  icon,
  className = "market-icon",
}: {
  id: string
  name: string
  icon?: string | null | undefined
  className?: string
}) {
  const [broken, setBroken] = useState<string | null>(null)
  if (icon && broken !== icon) {
    return (
      <img
        className={`entity-avatar ${className} market-icon-img`}
        src={icon}
        alt=""
        aria-hidden="true"
        draggable={false}
        onError={() => setBroken(icon)}
      />
    )
  }
  return <EntityAvatar id={id} name={name} className={className} />
}

/** 市场卡片上的操作。 */
export interface MarketActions {
  /** 正在安装或更新的「市场/插件」键，形如 `market:plugin`。 */
  pendingKey: string | null
  onInstall: (market: string, plugin: string) => void
  onUpdate: (pluginId: string) => void
  onDetails: (market: string, plugin: string) => void
}

export function marketKey(market: string, plugin: string): string {
  return `${market}:${plugin}`
}

function MarketTile({
  market,
  entry,
  installed,
  pendingKey,
  onInstall,
  onUpdate,
  onDetails,
}: MarketActions & {
  market: MarketplaceSummary
  entry: MarketplacePlugin
  installed: PluginSummary | undefined
}) {
  const { t, locale } = useLocale()
  const name = marketplacePluginName(entry, locale)
  const key = marketKey(market.id, entry.name)
  const pending = pendingKey === key || (installed !== undefined && pendingKey === installed.id)
  const update = updateFor(installed, market, entry)
  const description = marketplacePluginDescription(entry, locale) ?? entry.sourceLabel
  return (
    <div
      className="market-tile"
      data-market-plugin={entry.name}
      data-installed={installed ? "" : undefined}
    >
      <button
        type="button"
        className="market-tile-main"
        aria-label={fill(t("plugins.market.details"), { plugin: name })}
        onClick={() => onDetails(market.id, entry.name)}
      >
        <PluginIcon id={`${market.id}/${entry.name}`} name={name} icon={entry.icon} />
        <span className="market-tile-text">
          <span className="market-tile-name">
            <span className="truncate">{name}</span>
            {update ? (
              <span className="market-badge">{t("plugins.market.updateAvailable")}</span>
            ) : null}
          </span>
          <span className="market-tile-desc truncate" title={description}>
            {description}
          </span>
        </span>
      </button>
      <span className="market-tile-actions">
        {installed && update ? (
          <Button
            size="sm"
            type="button"
            className="market-pill"
            aria-label={fill(t("plugins.market.updateLabel"), { plugin: name })}
            disabled={pending}
            onClick={() => onUpdate(installed.id)}
          >
            {pending ? t("plugins.updating") : t("plugins.market.update")}
          </Button>
        ) : installed ? (
          <span className="market-installed">
            <Check className="ic ic-sm" aria-hidden="true" />
            {t("plugins.market.installed")}
          </span>
        ) : (
          <Button
            size="sm"
            type="button"
            className="market-pill"
            aria-label={fill(t("plugins.market.installLabel"), { plugin: name })}
            disabled={pending}
            onClick={() => onInstall(market.id, entry.name)}
          >
            <Download className="ic ic-sm" aria-hidden="true" />
            {pending ? t("plugins.installing") : t("plugins.market.install")}
          </Button>
        )}
      </span>
    </div>
  )
}

function matches(entry: MarketplacePlugin, needle: string, locale: Locale): boolean {
  return [
    marketplacePluginName(entry, locale),
    marketplacePluginDescription(entry, locale) ?? "",
    entry.displayName ?? "",
    entry.name,
    entry.author ?? "",
    entry.category ?? "",
  ].some((text) => text.toLowerCase().includes(needle))
}

const categories: Record<string, MessageKey> = {
  "developer-tools": "plugins.market.category.developerTools",
  productivity: "plugins.market.category.productivity",
}

export function OfficialCatalog({
  market,
  community,
  plugins,
  query,
  onBuiltinDetails,
  onBrowsePersonal,
  ...actions
}: MarketActions & {
  market: MarketplaceSummary | undefined
  community: boolean
  plugins: readonly PluginSummary[]
  query: string
  onBuiltinDetails: (id: string) => void
  onBrowsePersonal: () => void
}) {
  const { t, locale } = useLocale()
  const needle = query.trim().toLowerCase()
  const publisher = community ? "community" : "official"
  const builtins = community
    ? []
    : plugins.filter((plugin) => plugin.builtin && matchesPlugin(plugin, needle, locale))
  const groups = new Map<string, MarketplacePlugin[]>()
  for (const entry of market?.plugins ?? []) {
    if (entry.publisherType !== publisher || !matches(entry, needle, locale)) continue
    const category = entry.category ?? ""
    const group = groups.get(category) ?? []
    if (group.length === 0) groups.set(category, group)
    group.push(entry)
  }
  return (
    <div className="market-sections">
      {market?.error ? (
        <p className="market-section-error market-catalog-error" role="status">
          <TriangleAlert className="ic ic-sm" aria-hidden="true" />
          {t("plugins.market.catalogCached")}
        </p>
      ) : null}
      {market &&
        [...groups].map(([category, entries]) => {
          const key = Object.hasOwn(categories, category) ? categories[category] : undefined
          const title = key ? t(key) : category || t("plugins.market.category.other")
          return (
            <section className="market-section" key={category} aria-label={title}>
              <h2 className="market-section-title">{title}</h2>
              <div className="market-grid">
                {entries.map((entry) => (
                  <MarketTile
                    key={entry.name}
                    market={market}
                    entry={entry}
                    installed={plugins.find((plugin) => plugin.name === entry.name)}
                    {...actions}
                  />
                ))}
              </div>
            </section>
          )
        })}
      <BuiltinMarket plugins={builtins} onDetails={onBuiltinDetails} />
      {builtins.length === 0 && groups.size === 0 ? (
        <EmptyState
          className={community && !needle ? "market-empty market-community-empty" : "market-empty"}
          icon={
            needle ? (
              <Search className="ic" />
            ) : community ? (
              <Users className="ic" />
            ) : (
              <Package className="ic" />
            )
          }
          title={t(
            needle
              ? "plugins.noMatches"
              : community
                ? "plugins.market.communityEmpty"
                : "plugins.market.publicEmpty",
          )}
          description={community && !needle ? t("plugins.market.communityHint") : undefined}
          actions={
            community && !needle ? (
              <Button size="sm" type="button" onClick={onBrowsePersonal}>
                {t("plugins.market.browsePersonal")}
              </Button>
            ) : undefined
          }
        />
      ) : null}
    </div>
  )
}

function MarketSection({
  market,
  entries,
  plugins,
  sourceActions,
  ...actions
}: MarketActions & {
  market: MarketplaceSummary
  entries: readonly MarketplacePlugin[]
  plugins: readonly PluginSummary[]
  sourceActions?: SourceActions | undefined
}) {
  const { t, locale } = useLocale()
  const headingId = useId()
  const meta = [
    t(sourceTypeKeys[market.sourceType]),
    market.sourceLabel,
    fill(t("plugins.market.count"), { count: String(market.plugins.length) }),
    market.lastUpdated
      ? fill(t("plugins.market.updated"), { time: formatRelativeTime(market.lastUpdated, locale) })
      : t("plugins.market.neverUpdated"),
  ]
  return (
    <section className="market-section" aria-labelledby={headingId} data-marketplace={market.id}>
      <div className="market-section-head">
        <div className="market-section-titlebar">
          <h2 id={headingId} className="market-section-title">
            {market.displayName}
          </h2>
          {sourceActions ? (
            <SourceMenu
              market={market}
              actions={sourceActions}
              variant="section"
              label={fill(t("plugins.market.sectionMenu"), { market: market.displayName })}
            />
          ) : null}
        </div>
        <p className="market-section-meta truncate" title={meta.join(" · ")}>
          {meta.join(" · ")}
        </p>
        {market.error ? (
          <p className="market-section-error" role="note">
            <TriangleAlert className="ic ic-sm" aria-hidden="true" />
            <span className="truncate" title={market.error}>
              {fill(t("plugins.market.refreshFailed"), { reason: market.error })}
            </span>
          </p>
        ) : null}
      </div>
      {entries.length === 0 ? (
        <p className="market-section-empty">{t("plugins.market.noPlugins")}</p>
      ) : (
        <div className="market-grid">
          {entries.map((entry) => (
            <MarketTile
              key={entry.name}
              market={market}
              entry={entry}
              installed={plugins.find((plugin) => plugin.name === entry.name)}
              {...actions}
            />
          ))}
        </div>
      )}
    </section>
  )
}

export interface PluginMarketProps extends MarketActions {
  /** 要列出的市场；停用的市场源不传进来。 */
  marketplaces: readonly MarketplaceSummary[]
  plugins: readonly PluginSummary[]
  query?: string | undefined
  /** 停用的市场源有几个；市场源都停用了时说明一下，而不是当成还没有市场。 */
  disabledCount?: number | undefined
  /** 组标题旁「⋯」菜单里的操作；不给时没有菜单。 */
  sourceActions?: SourceActions | undefined
  onAddMarketplace: () => void
  onInstallFromGitHub: () => void
  onCreatePlugin?: (() => void) | undefined
}

/** 渲染插件市场；还没有市场、市场源都停用了或搜索没有结果时显示空状态。 */
export function PluginMarket({
  marketplaces,
  plugins,
  query = "",
  disabledCount = 0,
  sourceActions,
  onAddMarketplace,
  onInstallFromGitHub,
  onCreatePlugin,
  ...actions
}: PluginMarketProps) {
  const { t, locale } = useLocale()
  const needle = query.trim().toLowerCase()
  if (marketplaces.length === 0 && disabledCount > 0) {
    return (
      <EmptyState
        className="market-empty"
        icon={<PowerOff className="ic" />}
        title={t("plugins.market.allDisabled")}
        description={t("plugins.market.allDisabledHint")}
        actions={
          sourceActions?.onManage ? (
            <Button size="sm" type="button" onClick={sourceActions.onManage}>
              {t("plugins.market.manageSources")}
            </Button>
          ) : undefined
        }
      />
    )
  }
  if (marketplaces.length === 0) {
    return (
      <div className="market-hero">
        <span className="market-hero-icon" aria-hidden="true">
          <Store className="ic" />
        </span>
        <h2>{t("plugins.market.empty")}</h2>
        <p>{t("plugins.market.emptyHint")}</p>
        <div className="market-hero-actions">
          <Button size="sm" variant="primary" type="button" onClick={onAddMarketplace}>
            {t("plugins.add.marketplace")}
          </Button>
          <Button size="sm" type="button" onClick={onInstallFromGitHub}>
            <GitBranch className="ic ic-sm" aria-hidden="true" />
            {t("plugins.market.fromGitHub")}
          </Button>
          {onCreatePlugin ? (
            <Button size="sm" type="button" onClick={onCreatePlugin}>
              <Sparkles className="ic ic-sm" aria-hidden="true" />
              {t("plugins.add.create")}
            </Button>
          ) : null}
        </div>
      </div>
    )
  }
  const sections = marketplaces.map((market) => ({
    market,
    entries: needle
      ? market.plugins.filter((entry) => matches(entry, needle, locale))
      : market.plugins,
  }))
  if (needle && sections.every((section) => section.entries.length === 0)) {
    return (
      <EmptyState
        className="market-empty"
        icon={<Search className="ic" />}
        title={t("plugins.noMatches")}
      />
    )
  }
  return (
    <div className="market-sections">
      {sections
        .filter((section) => !needle || section.entries.length > 0)
        .map(({ market, entries }) => (
          <MarketSection
            key={market.id}
            market={market}
            entries={entries}
            plugins={plugins}
            sourceActions={sourceActions}
            {...actions}
          />
        ))}
    </div>
  )
}
