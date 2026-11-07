// 插件市场：每个市场一组，组头是名称、来源与更新时间，标题旁「⋯」里是这个市场源的操作，下面两列卡片。
// 卡片上是图标、名称与一句话说明，右边是「安装」、「更新」或「已安装」；点卡片看详情。
// 还没有市场时是一块说明，带添加市场、从 GitHub 安装与创建插件。
import { useId, useState } from "react"
import { Download, GitBranch, PowerOff, Search, Sparkles, Store, TriangleAlert } from "lucide-react"
import {
  Button,
  EmptyState,
  EntityAvatar,
  formatRelativeTime,
  useLocale,
} from "@pigcode/ui-primitives"
import {
  fill,
  sourceTypeKeys,
  updateFor,
  type MarketplacePlugin,
  type MarketplaceSummary,
  type PluginSummary,
} from "./plugin-summary"
import { SourceMenu, type SourceActions } from "./marketplace-sources"

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
  const { t } = useLocale()
  const name = entry.displayName ?? entry.name
  const key = marketKey(market.id, entry.name)
  const pending = pendingKey === key || (installed !== undefined && pendingKey === installed.id)
  const update = updateFor(installed, market, entry)
  const description = entry.description ?? entry.sourceLabel
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
          <span className="market-installed">{t("plugins.market.installed")}</span>
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

function matches(entry: MarketplacePlugin, needle: string): boolean {
  return [entry.displayName ?? "", entry.name, entry.description ?? "", entry.category ?? ""].some(
    (text) => text.toLowerCase().includes(needle),
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
  const { t } = useLocale()
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
    entries: needle ? market.plugins.filter((entry) => matches(entry, needle)) : market.plugins,
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
