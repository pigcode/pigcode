// 插件卡片区：按类型分组，每组两列卡片。卡片上是图标、名称与一行说明，右边是「打开」、更多菜单与启用开关；
// 点卡片看详情。一组超过三行时先收起，组底下可以展开全部。
import { useId, useState } from "react"
import { Box, Ellipsis, Plus, Search } from "lucide-react"
import {
  Badge,
  Button,
  EmptyState,
  EntityAvatar,
  Menu,
  StatusDot,
  Switch,
  useLocale,
} from "@pigcode/ui-primitives"
import {
  KIND_ORDER,
  descriptionOf,
  fill,
  kindKeys,
  statusOf,
  type PluginKind,
  type PluginSummary,
} from "./plugin-summary"

/** 一组收起时显示的卡片数：两列三行。 */
const COLLAPSED_COUNT = 6

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
  /** 搜索词；非空时只留名称、说明或包名里有它的插件，各组全部展开。 */
  query?: string | undefined
  /** 打开安装对话框；给了它，没有插件时空状态里出现「安装插件」。 */
  onInstall?: (() => void) | undefined
}

/** 名称、说明或包名里有没有搜索词（已转小写）。 */
function matches(plugin: PluginSummary, needle: string, description: string | null): boolean {
  return [plugin.displayName ?? plugin.name, plugin.name, description ?? ""].some((text) =>
    text.toLowerCase().includes(needle),
  )
}

function PluginTile({
  plugin,
  pendingId,
  onEnable,
  onDisable,
  onDetails,
  canUninstall,
  onOpenSettings,
  onUpdate,
  updatable,
}: TileActions & { plugin: PluginSummary }) {
  const { t, locale } = useLocale()
  const [menuOpen, setMenuOpen] = useState(false)
  const name = plugin.displayName ?? plugin.name
  const status = statusOf(plugin)
  const pending = pendingId === plugin.id
  const problem = status.tone === "error" || status.tone === "warning"
  const settingsPage = plugin.settingsPage
  const description =
    descriptionOf(plugin, locale) ??
    (name !== plugin.name
      ? plugin.name
      : fill(t("plugins.versionLabel"), { version: plugin.version }))
  return (
    <div
      className="market-tile"
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
        <EntityAvatar id={plugin.id} name={name} className="market-icon" />
        <span className="market-tile-text">
          <span className="market-tile-name">
            <span className="truncate">{name}</span>
            {plugin.builtin ? <Badge>{t("plugins.builtin")}</Badge> : null}
            {updatable?.has(plugin.id) ? (
              <span className="market-badge">{t("plugins.market.updateAvailable")}</span>
            ) : null}
          </span>
          {problem ? (
            <span className="market-tile-desc" data-tone={status.tone}>
              <StatusDot tone={status.tone} />
              <span className="truncate">{t(status.label)}</span>
            </span>
          ) : (
            <span className="market-tile-desc truncate" title={description}>
              {description}
            </span>
          )}
        </span>
      </button>
      <span className="market-tile-actions">
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
                {onUpdate && plugin.origin && !plugin.builtin ? (
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
    </div>
  )
}

function PluginSection({
  kind,
  plugins,
  expandAll,
  ...actions
}: TileActions & { kind: PluginKind; plugins: readonly PluginSummary[]; expandAll: boolean }) {
  const { t } = useLocale()
  const headingId = useId()
  const [expanded, setExpanded] = useState(false)
  const collapsible = !expandAll && plugins.length > COLLAPSED_COUNT
  const visible = collapsible && !expanded ? plugins.slice(0, COLLAPSED_COUNT) : plugins
  return (
    <section className="market-section" aria-labelledby={headingId}>
      <h2 id={headingId} className="market-section-title">
        {t(kindKeys[kind])}
      </h2>
      <div className="market-grid">
        {visible.map((plugin) => (
          <PluginTile key={plugin.id} plugin={plugin} {...actions} />
        ))}
      </div>
      {collapsible ? (
        <button
          type="button"
          className="market-more"
          aria-expanded={expanded}
          onClick={() => setExpanded((value) => !value)}
        >
          {expanded
            ? t("plugins.showLess")
            : fill(t("plugins.showAll"), { count: String(plugins.length) })}
        </button>
      ) : null}
    </section>
  )
}

/** 渲染按类型分组的插件卡片；没有插件或搜索没有结果时显示空状态。 */
export function PluginList({ plugins, query = "", onInstall, ...actions }: PluginListProps) {
  const { t, locale } = useLocale()
  const needle = query.trim().toLowerCase()
  const shown = needle
    ? plugins.filter((plugin) => matches(plugin, needle, descriptionOf(plugin, locale)))
    : plugins

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
      {KIND_ORDER.map((kind) => {
        const items = shown.filter((plugin) => plugin.kind === kind)
        return items.length > 0 ? (
          <PluginSection
            key={kind}
            kind={kind}
            plugins={items}
            expandAll={needle !== ""}
            {...actions}
          />
        ) : null
      })}
    </div>
  )
}
