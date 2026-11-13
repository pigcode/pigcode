// 市场源管理：列出每个市场源（启用的在前），可以启停、刷新、在浏览器或文件夹里打开、复制地址和删除（删除先确认）。
// 插件市场里每组标题旁的「⋯」也用这里的 SourceMenu。
import { useEffect, useState } from "react"
import {
  Copy,
  Ellipsis,
  ExternalLink,
  FileBraces,
  Folder,
  FolderOpen,
  GitBranch,
  Link2,
  Plus,
  PowerOff,
  RefreshCw,
  Settings2,
  Trash2,
  TriangleAlert,
  type LucideIcon,
} from "lucide-react"
import {
  Button,
  Dialog,
  Menu,
  Switch,
  copyText,
  formatRelativeTime,
  useLocale,
} from "@pigcode/ui-primitives"
import {
  fill,
  isMarketEnabled,
  pluginErrorText,
  sortSources,
  sourceTypeKeys,
  type MarketplaceSummary,
  type PluginSummary,
} from "./plugin-summary"

/** 来源类型的图标。 */
const SOURCE_ICONS: Record<MarketplaceSummary["sourceType"], LucideIcon> = {
  github: GitBranch,
  git: GitBranch,
  url: Link2,
  directory: Folder,
  file: FileBraces,
}

/** 「全部刷新」进行中时的 pendingId。 */
export const REFRESH_ALL_SOURCES = "refresh-sources"

/** 市场源上的操作；没给的那一项不出现在菜单里。 */
export interface SourceActions {
  onRefresh?: ((id: string) => void) | undefined
  onSetEnabled?: ((id: string, enabled: boolean) => void) | undefined
  onOpenExternal?: ((url: string) => void) | undefined
  onRevealPath?: ((path: string) => void) | undefined
  /** 复制完来源地址之后调用，用来给出提示。 */
  onCopied?: (() => void) | undefined
  /** 打开市场源管理。 */
  onManage?: (() => void) | undefined
}

/**
 * 市场源的「⋯」菜单。插件市场的组标题旁（section）：刷新、停用、打开来源、复制地址、管理市场源；
 * 市场源管理的一行（row）：打开来源、复制地址、删除。
 */
export function SourceMenu({
  market,
  actions,
  variant,
  label,
  onRemove,
}: {
  market: MarketplaceSummary
  actions: SourceActions
  variant: "section" | "row"
  label: string
  /** 行里的「删除市场源」：先在行里确认，不直接删。 */
  onRemove?: (() => void) | undefined
}) {
  const { t } = useLocale()
  const url = market.sourceUrl ?? null
  const path = market.sourcePath ?? null
  const open =
    url && actions.onOpenExternal ? (
      <Menu.Item onClick={() => actions.onOpenExternal?.(url)}>
        <ExternalLink className="ic" aria-hidden="true" />
        <span className="grow">{t("plugins.sourcesDialog.openUrl")}</span>
      </Menu.Item>
    ) : path && actions.onRevealPath ? (
      <Menu.Item onClick={() => actions.onRevealPath?.(path)}>
        <FolderOpen className="ic" aria-hidden="true" />
        <span className="grow">{t("plugins.sourcesDialog.reveal")}</span>
      </Menu.Item>
    ) : null
  const copy = (
    <Menu.Item
      onClick={() => {
        void copyText(market.sourceLabel).then(() => actions.onCopied?.())
      }}
    >
      <Copy className="ic" aria-hidden="true" />
      <span className="grow">{t("plugins.sourcesDialog.copy")}</span>
    </Menu.Item>
  )
  return (
    <Menu.Root>
      <Menu.Trigger
        className="icon-btn source-menu-trigger"
        type="button"
        aria-label={label}
        title={label}
      >
        <Ellipsis className="ic ic-sm" aria-hidden="true" />
      </Menu.Trigger>
      <Menu.Portal>
        <Menu.Positioner side="bottom" align="end" sideOffset={4}>
          <Menu.Popup className="source-menu">
            {variant === "section" ? (
              <>
                {actions.onRefresh ? (
                  <Menu.Item onClick={() => actions.onRefresh?.(market.id)}>
                    <RefreshCw className="ic" aria-hidden="true" />
                    <span className="grow">{t("plugins.market.refreshSource")}</span>
                  </Menu.Item>
                ) : null}
                {actions.onSetEnabled ? (
                  <Menu.Item onClick={() => actions.onSetEnabled?.(market.id, false)}>
                    <PowerOff className="ic" aria-hidden="true" />
                    <span className="grow">{t("plugins.market.disableSource")}</span>
                  </Menu.Item>
                ) : null}
                {open}
                {copy}
                {actions.onManage ? (
                  <>
                    <Menu.Separator />
                    <Menu.Item onClick={() => actions.onManage?.()}>
                      <Settings2 className="ic" aria-hidden="true" />
                      <span className="grow">{t("plugins.market.manageSources")}</span>
                    </Menu.Item>
                  </>
                ) : null}
              </>
            ) : (
              <>
                {open}
                {copy}
                {onRemove ? (
                  <>
                    <Menu.Separator />
                    <Menu.Item data-danger="" onClick={onRemove}>
                      <Trash2 className="ic" aria-hidden="true" />
                      <span className="grow">{t("plugins.sourcesDialog.removeItem")}</span>
                    </Menu.Item>
                  </>
                ) : null}
              </>
            )}
          </Menu.Popup>
        </Menu.Positioner>
      </Menu.Portal>
    </Menu.Root>
  )
}

export interface MarketplaceSourcesDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  marketplaces: readonly MarketplaceSummary[]
  /** 已安装的插件；每个来源装了几个按它数。 */
  plugins?: readonly PluginSummary[] | undefined
  /** 正在刷新、启停或删除的市场 id；全部刷新时是 REFRESH_ALL_SOURCES。 */
  pendingId: string | null
  onRefresh: (id: string) => void
  /** 刷新全部启用的来源。 */
  onRefreshAll?: (() => void) | undefined
  onSetEnabled?: ((id: string, enabled: boolean) => void) | undefined
  onRemove: (id: string) => void
  onAdd: () => void
  onOpenExternal?: ((url: string) => void) | undefined
  onRevealPath?: ((path: string) => void) | undefined
}

export function MarketplaceSourcesDialog({
  open,
  onOpenChange,
  marketplaces,
  plugins = [],
  pendingId,
  onRefresh,
  onRefreshAll,
  onSetEnabled,
  onRemove,
  onAdd,
  onOpenExternal,
  onRevealPath,
}: MarketplaceSourcesDialogProps) {
  const { t, locale } = useLocale()
  const [confirming, setConfirming] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  useEffect(() => {
    if (!open) {
      setConfirming(null)
      setNotice(null)
    }
  }, [open])
  useEffect(() => {
    if (!notice) return undefined
    const timer = setTimeout(() => setNotice(null), 2400)
    return () => clearTimeout(timer)
  }, [notice])

  const disabled = marketplaces.filter((market) => !isMarketEnabled(market)).length
  const summary =
    disabled > 0
      ? fill(t("plugins.sourcesDialog.summaryDisabled"), {
          count: String(marketplaces.length),
          disabled: String(disabled),
        })
      : fill(t("plugins.sourcesDialog.summary"), { count: String(marketplaces.length) })
  const refreshingAll = pendingId === REFRESH_ALL_SOURCES
  const actions: SourceActions = {
    onOpenExternal,
    onRevealPath,
    onCopied: () => setNotice(t("plugins.sourcesDialog.copied")),
  }

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Content
        className="marketplace-sources"
        title={t("plugins.sourcesDialog.title")}
        description={t("plugins.sourcesDialog.description")}
        closeLabel={t("common.close")}
      >
        <Dialog.Body>
          <div className="marketplace-sources-bar">
            <span className="marketplace-sources-summary" role="status">
              {notice ?? summary}
            </span>
            {onRefreshAll && marketplaces.length > disabled ? (
              <Button
                size="sm"
                variant="ghost"
                type="button"
                disabled={refreshingAll}
                onClick={onRefreshAll}
              >
                <RefreshCw
                  className={refreshingAll ? "ic ic-sm spin" : "ic ic-sm"}
                  aria-hidden="true"
                />
                {t("plugins.sourcesDialog.refreshAll")}
              </Button>
            ) : null}
            <Button size="sm" type="button" onClick={onAdd}>
              <Plus className="ic ic-sm" aria-hidden="true" />
              {t("plugins.sourcesDialog.add")}
            </Button>
          </div>
          {marketplaces.length === 0 ? (
            <p className="marketplace-sources-empty">{t("plugins.sourcesDialog.empty")}</p>
          ) : (
            <ul className="marketplace-source-list">
              {sortSources(marketplaces).map((market) => {
                const enabled = isMarketEnabled(market)
                const busy = pendingId === market.id || (refreshingAll && enabled)
                const installed = plugins.filter(
                  (plugin) =>
                    plugin.origin?.kind === "marketplace" &&
                    plugin.origin.marketplace === market.id,
                ).length
                const SourceIcon = SOURCE_ICONS[market.sourceType]
                const meta = [
                  fill(t("plugins.market.count"), { count: String(market.plugins.length) }),
                  ...(installed > 0
                    ? [fill(t("plugins.sourcesDialog.installed"), { count: String(installed) })]
                    : []),
                  market.lastUpdated
                    ? fill(t("plugins.market.updated"), {
                        time: formatRelativeTime(market.lastUpdated, locale),
                      })
                    : t("plugins.market.neverUpdated"),
                ]
                return (
                  <li
                    key={market.id}
                    className="marketplace-source"
                    data-marketplace={market.id}
                    data-enabled={enabled ? undefined : "false"}
                  >
                    <span className="marketplace-source-icon" aria-hidden="true">
                      <SourceIcon className="ic ic-sm" />
                    </span>
                    <div className="marketplace-source-text">
                      <span className="marketplace-source-name">
                        <span className="truncate">{market.displayName}</span>
                        <span className="marketplace-source-type">
                          {t(sourceTypeKeys[market.sourceType])}
                        </span>
                        {enabled ? null : (
                          <span className="marketplace-source-type is-off">
                            {t("plugins.sourcesDialog.disabled")}
                          </span>
                        )}
                      </span>
                      <span
                        className="marketplace-source-label mono truncate"
                        title={market.sourceLabel}
                      >
                        {market.sourceLabel}
                      </span>
                      <span className="marketplace-source-meta">{meta.join(" · ")}</span>
                      {market.error ? (
                        <span className="marketplace-source-error">
                          <TriangleAlert className="ic ic-xs" aria-hidden="true" />
                          <span>
                            {fill(t("plugins.market.refreshFailed"), {
                              reason: pluginErrorText(market.error, t),
                            })}
                          </span>
                        </span>
                      ) : null}
                      {confirming === market.id ? (
                        <span className="marketplace-source-confirm">
                          <span>
                            {fill(t("plugins.sourcesDialog.removeConfirm"), {
                              market: market.displayName,
                            })}
                          </span>
                          <Button
                            size="sm"
                            variant="ghost"
                            type="button"
                            onClick={() => setConfirming(null)}
                          >
                            {t("common.cancel")}
                          </Button>
                          <Button
                            size="sm"
                            variant="solidDanger"
                            type="button"
                            disabled={busy}
                            onClick={() => {
                              setConfirming(null)
                              onRemove(market.id)
                            }}
                          >
                            {t("plugins.sourcesDialog.removeAction")}
                          </Button>
                        </span>
                      ) : null}
                    </div>
                    <span className="marketplace-source-actions">
                      {onSetEnabled ? (
                        <Switch
                          aria-label={fill(t("plugins.sourcesDialog.toggle"), {
                            market: market.displayName,
                          })}
                          checked={enabled}
                          disabled={pendingId === market.id}
                          onCheckedChange={(checked) => onSetEnabled(market.id, checked)}
                        />
                      ) : null}
                      <Button
                        size="icon"
                        variant="ghost"
                        type="button"
                        aria-label={fill(t("plugins.sourcesDialog.refresh"), {
                          market: market.displayName,
                        })}
                        title={fill(t("plugins.sourcesDialog.refresh"), {
                          market: market.displayName,
                        })}
                        disabled={busy || !enabled}
                        onClick={() => onRefresh(market.id)}
                      >
                        <RefreshCw
                          className={busy ? "ic ic-sm spin" : "ic ic-sm"}
                          aria-hidden="true"
                        />
                      </Button>
                      <SourceMenu
                        market={market}
                        actions={actions}
                        variant="row"
                        label={fill(t("plugins.sourcesDialog.more"), {
                          market: market.displayName,
                        })}
                        onRemove={() => setConfirming(market.id)}
                      />
                    </span>
                  </li>
                )
              })}
            </ul>
          )}
        </Dialog.Body>
        <Dialog.Footer>
          <Dialog.Close render={<Button size="sm" variant="primary" type="button" />}>
            {t("common.close")}
          </Dialog.Close>
        </Dialog.Footer>
      </Dialog.Content>
    </Dialog.Root>
  )
}
