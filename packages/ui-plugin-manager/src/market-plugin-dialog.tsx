// 插件市场里一个插件的详情：图标、名称与说明，版本、分类、作者、来源、所在市场与主页；
// 底部是「安装」，装过的显示已安装的版本，市场里有新版本时是「更新」。
import { useState } from "react"
import { Download, ExternalLink } from "lucide-react"
import { Badge, Button, Dialog, useLocale } from "@pigcode/ui-primitives"
import { PluginIcon } from "./plugin-market"
import {
  fill,
  updateFor,
  type MarketplacePlugin,
  type MarketplaceSummary,
  type PluginSummary,
} from "./plugin-summary"

/** 正在看的市场插件：所在市场与条目。 */
export interface MarketSelection {
  market: MarketplaceSummary
  entry: MarketplacePlugin
}

export interface MarketPluginDialogProps {
  selection: MarketSelection | null
  plugins: readonly PluginSummary[]
  pending: boolean
  onClose: () => void
  onInstall: (market: string, plugin: string) => void
  onUpdate: (pluginId: string) => void
  /** 用系统浏览器打开主页；缺省时主页只显示地址。 */
  onOpenExternal?: ((url: string) => void) | undefined
}

function Body({
  selection,
  plugins,
  pending,
  onInstall,
  onUpdate,
  onOpenExternal,
}: Omit<MarketPluginDialogProps, "selection" | "onClose"> & { selection: MarketSelection }) {
  const { t } = useLocale()
  const { market, entry } = selection
  const name = entry.displayName ?? entry.name
  const installed = plugins.find((plugin) => plugin.name === entry.name)
  const update = updateFor(installed, market, entry)
  return (
    <Dialog.Content
      className="plugin-dialog"
      closeLabel={t("common.close")}
      title={
        <>
          <PluginIcon id={`${market.id}/${entry.name}`} name={name} icon={entry.icon} />
          {name}
        </>
      }
      description={
        <span className="plugin-dialog-meta">
          {entry.category ? <Badge>{entry.category}</Badge> : null}
          {installed ? (
            <Badge variant="ok">
              {fill(t("plugins.entry.installedVersion"), { version: installed.version })}
            </Badge>
          ) : null}
          {entry.version ? <span className="plugin-dialog-version">{entry.version}</span> : null}
        </span>
      }
    >
      <Dialog.Body className="plugin-dialog-body">
        {entry.description ? <p className="agent-description">{entry.description}</p> : null}
        {update && entry.version ? (
          <p className="market-update-hint">
            {fill(t("plugins.entry.updateHint"), { version: entry.version })}
          </p>
        ) : null}
        <dl className="ext-facts">
          <dt>{t("plugins.entry.package")}</dt>
          <dd className="mono">{entry.name}</dd>
          {entry.version ? (
            <>
              <dt>{t("plugins.entry.version")}</dt>
              <dd>{entry.version}</dd>
            </>
          ) : null}
          {entry.author ? (
            <>
              <dt>{t("plugins.entry.author")}</dt>
              <dd>{entry.author}</dd>
            </>
          ) : null}
          <dt>{t("plugins.entry.marketplace")}</dt>
          <dd>{market.displayName}</dd>
          <dt>{t("plugins.entry.source")}</dt>
          <dd className="mono">{entry.sourceLabel}</dd>
          {entry.homepage ? (
            <>
              <dt>{t("plugins.entry.homepage")}</dt>
              <dd>
                {onOpenExternal ? (
                  <button
                    type="button"
                    className="market-link"
                    onClick={() => onOpenExternal(entry.homepage!)}
                  >
                    <span className="truncate">{entry.homepage}</span>
                    <ExternalLink className="ic ic-sm" aria-hidden="true" />
                  </button>
                ) : (
                  <span className="mono">{entry.homepage}</span>
                )}
              </dd>
            </>
          ) : null}
        </dl>
      </Dialog.Body>
      <Dialog.Footer className="plugin-dialog-foot">
        {installed && update ? (
          <Button
            size="sm"
            variant="primary"
            type="button"
            disabled={pending}
            onClick={() => onUpdate(installed.id)}
          >
            {pending ? t("plugins.updating") : t("plugins.market.update")}
          </Button>
        ) : installed ? (
          <Button size="sm" type="button" disabled>
            {t("plugins.market.installed")}
          </Button>
        ) : (
          <Button
            size="sm"
            variant="primary"
            type="button"
            disabled={pending}
            onClick={() => onInstall(market.id, entry.name)}
          >
            <Download className="ic ic-sm" aria-hidden="true" />
            {pending ? t("plugins.installing") : t("plugins.market.install")}
          </Button>
        )}
      </Dialog.Footer>
    </Dialog.Content>
  )
}

/** 渲染市场插件详情；关闭的动画里继续画最后看的那个，内容不会先变空。 */
export function MarketPluginDialog({ selection, ...props }: MarketPluginDialogProps) {
  const [last, setLast] = useState(selection)
  if (selection !== null && selection !== last) setLast(selection)
  const shown = selection ?? last
  return (
    <Dialog.Root
      open={selection !== null}
      onOpenChange={(open) => {
        if (!open) props.onClose()
      }}
    >
      {shown ? (
        <Body key={`${shown.market.id}:${shown.entry.name}`} selection={shown} {...props} />
      ) : null}
    </Dialog.Root>
  )
}
