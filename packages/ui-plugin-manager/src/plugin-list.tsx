// 插件管理按已安装与内置分组。每行显示版本和来源，可打开详情、设置或直接启停。
import { useId, useState } from "react"
import { Box, Ellipsis, Plus, Search } from "lucide-react"
import {
  Button,
  EmptyState,
  Menu,
  StatusDot,
  Switch,
  useLocale,
  type MessageKey,
} from "@pigcode/ui-primitives"
import { InstalledPluginIcon } from "./installed-plugin-icon"
import {
  descriptionOf,
  fill,
  matchesPlugin,
  showsPackageVersion,
  statusOf,
  type MarketplaceSummary,
  type PluginSummary,
} from "./plugin-summary"

export type PluginStatusFilter = "all" | "enabled" | "disabled"

/** 卡片上的操作。 */
interface TileActions {
  /** 正在处理的插件 id，用于禁用开关与按钮。 */
  pendingId: string | null
  onEnable: (id: string) => void
  onDisable: (id: string) => void
  /** 打开插件详情；confirmUninstall 时详情直接停在「确认卸载」上。 */
  onDetails: (id: string, confirmUninstall?: boolean) => void
  /** 给了它，用户安装的插件在更多菜单里有「卸载」；内置插件没有。 */
  canUninstall?: boolean | undefined
  /** 打开插件的设置页；缺省时不显示「打开」。 */
  onOpenSettings?: ((page: string) => void) | undefined
  /** 按来源重新安装；给了它，记得来源的用户插件在更多菜单里有「更新」。 */
  onUpdate?: ((id: string) => void) | undefined
  /** 插件市场里有新版本的插件 id，卡片上标「可更新」。 */
  updatable?: ReadonlySet<string> | undefined
}

/** 插件卡片区需要的状态与事件。 */
export interface PluginListProps extends TileActions {
  plugins: PluginSummary[]
  marketplaces?: readonly MarketplaceSummary[] | undefined
  /** 搜索显示名、说明或包名。 */
  query?: string | undefined
  filter?: PluginStatusFilter | undefined
  /** 打开安装对话框；给了它，没有插件时空状态里出现「安装插件」。 */
  onInstall?: (() => void) | undefined
}

function PluginTile({
  plugin,
  source,
  pendingId,
  onEnable,
  onDisable,
  onDetails,
  canUninstall,
  onOpenSettings,
  onUpdate,
  updatable,
}: TileActions & { plugin: PluginSummary; source: string | null | undefined }) {
  const { t, locale } = useLocale()
  const [menuOpen, setMenuOpen] = useState(false)
  const name = plugin.displayName ?? plugin.name
  const status = statusOf(plugin)
  const pending = pendingId === plugin.id
  const problem = status.tone === "error" || status.tone === "warning"
  const hasUpdate = !plugin.builtin && updatable?.has(plugin.id)
  const settingsPage = plugin.settingsPage
  const description = descriptionOf(plugin, locale) ?? (name !== plugin.name ? plugin.name : null)
  return (
    <li
      className="market-tile installed-plugin-row"
      data-plugin={plugin.name}
      data-enabled={plugin.enabled ? "true" : "false"}
      data-menu-open={menuOpen ? "" : undefined}
    >
      <button
        type="button"
        className="market-tile-main"
        aria-label={fill(t("plugins.expand"), { plugin: name })}
        onClick={() => onDetails(plugin.id)}
      >
        <InstalledPluginIcon plugin={plugin} />
        <span className="market-tile-text">
          <span className="market-tile-name">
            <span className="truncate">{name}</span>
          </span>
          <span className="installed-plugin-subtitle">
            {showsPackageVersion(plugin) && (
              <span className="installed-plugin-version">{plugin.version}</span>
            )}
            {source ? (
              <span
                className="installed-plugin-source truncate"
                title={plugin.originLabel ?? source}
              >
                {source}
              </span>
            ) : null}
            {problem ? (
              <span className="market-tile-desc" data-tone={status.tone}>
                <StatusDot tone={status.tone} />
                <span className="truncate">{t(status.label)}</span>
              </span>
            ) : description ? (
              <span className="market-tile-desc truncate" title={description}>
                {description}
              </span>
            ) : null}
          </span>
        </span>
      </button>
      <span className="market-tile-actions">
        {hasUpdate && onUpdate ? (
          <Button
            size="sm"
            type="button"
            className="market-pill"
            aria-label={fill(t("plugins.market.updateLabel"), { plugin: name })}
            disabled={pending}
            onClick={() => onUpdate(plugin.id)}
          >
            {pending ? t("plugins.updating") : t("plugins.update")}
          </Button>
        ) : null}
        <Menu.Root open={menuOpen} onOpenChange={setMenuOpen}>
          <Menu.Trigger
            className="icon-btn market-tile-menu"
            aria-label={fill(t("plugins.more"), { plugin: name })}
            title={fill(t("plugins.more"), { plugin: name })}
          >
            <Ellipsis className="ic ic-sm" aria-hidden="true" />
          </Menu.Trigger>
          <Menu.Portal>
            <Menu.Positioner side="bottom" align="end" sideOffset={4}>
              <Menu.Popup className="market-menu">
                <Menu.Item onClick={() => onDetails(plugin.id)}>{t("plugins.details")}</Menu.Item>
                {onUpdate && plugin.origin && !plugin.builtin && !hasUpdate ? (
                  <Menu.Item disabled={pending} onClick={() => onUpdate(plugin.id)}>
                    {t("plugins.update")}
                  </Menu.Item>
                ) : null}
                {canUninstall && !plugin.builtin ? (
                  <>
                    <Menu.Separator />
                    <Menu.Item data-danger="" onClick={() => onDetails(plugin.id, true)}>
                      {t("plugins.uninstall")}
                    </Menu.Item>
                  </>
                ) : null}
              </Menu.Popup>
            </Menu.Positioner>
          </Menu.Portal>
        </Menu.Root>
        {settingsPage && onOpenSettings ? (
          <Button
            size="sm"
            variant="plain"
            type="button"
            className="market-open"
            aria-label={fill(t("plugins.openLabel"), { plugin: name })}
            onClick={() => onOpenSettings(settingsPage)}
          >
            {t("plugins.open")}
          </Button>
        ) : null}
        <Switch
          aria-label={fill(t("plugins.toggle"), { plugin: name })}
          checked={plugin.enabled}
          disabled={pending}
          onCheckedChange={(checked) => (checked ? onEnable(plugin.id) : onDisable(plugin.id))}
        />
      </span>
    </li>
  )
}

function PluginSection({
  label,
  plugins,
  marketplaces,
  ...actions
}: TileActions & {
  label: MessageKey
  plugins: readonly PluginSummary[]
  marketplaces: readonly MarketplaceSummary[]
}) {
  const { t } = useLocale()
  const headingId = useId()
  if (plugins.length === 0) return null
  return (
    <section className="market-section" aria-labelledby={headingId}>
      <div className="installed-section-heading">
        <h2 id={headingId}>{t(label)}</h2>
        <span className="installed-section-count">{plugins.length}</span>
      </div>
      <ul className="installed-plugin-rows">
        {plugins.map((plugin) => {
          const marketId = plugin.origin?.kind === "marketplace" ? plugin.origin.marketplace : null
          const market = marketplaces.find((item) => item.id === marketId)
          const source =
            plugin.origin?.kind === "local"
              ? t("plugins.market.source.directory")
              : (market?.displayName ?? plugin.originLabel ?? marketId)
          return <PluginTile key={plugin.id} plugin={plugin} source={source} {...actions} />
        })}
      </ul>
    </section>
  )
}

/** 渲染已安装和内置插件组。 */
export function PluginList({
  plugins,
  marketplaces = [],
  query = "",
  filter = "all",
  onInstall,
  ...actions
}: PluginListProps) {
  const { t, locale } = useLocale()
  const needle = query.trim().toLowerCase()
  const shown = plugins.filter(
    (plugin) =>
      (filter === "all" || plugin.enabled === (filter === "enabled")) &&
      matchesPlugin(plugin, needle, locale),
  )

  if (plugins.length === 0) {
    return (
      <EmptyState
        className="group market-empty"
        icon={<Box className="ic" />}
        title={t("plugins.empty")}
        description={t("plugins.emptyHint")}
        actions={
          onInstall ? (
            <Button size="sm" type="button" onClick={onInstall}>
              <Plus className="ic ic-sm" aria-hidden="true" />
              {t("plugins.install")}
            </Button>
          ) : null
        }
      />
    )
  }
  if (shown.length === 0) {
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
      <PluginSection
        label="plugins.market.installed"
        plugins={shown.filter((plugin) => !plugin.builtin)}
        marketplaces={marketplaces}
        {...actions}
      />
      <PluginSection
        label="plugins.builtin"
        plugins={shown.filter((plugin) => plugin.builtin)}
        marketplaces={marketplaces}
        {...actions}
      />
    </div>
  )
}
