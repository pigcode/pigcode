// 插件详情对话框：头像、名称与状态，说明、包名、权限与提供的服务，冲突与错误；底部是卸载。
import { useState } from "react"
import {
  Badge,
  Button,
  Dialog,
  EntityAvatar,
  StatusDot,
  useLocale,
  type MessageKey,
} from "@pigcode/ui-primitives"
import {
  descriptionOf,
  fill,
  kindKeys,
  statusOf,
  type PluginClientError,
  type PluginContributionConflict,
  type PluginExtensionPoint,
  type PluginSummary,
} from "./plugin-summary"

/** 扩展点的本地化名称。 */
const pointKeys: Record<PluginExtensionPoint, MessageKey> = {
  panel: "extensionPoint.panel",
  surface: "extensionPoint.surface",
  settingsPage: "extensionPoint.settingsPage",
  command: "extensionPoint.command",
  toolRenderer: "extensionPoint.toolRenderer",
}

/** 有名字的内置功能（扩展点冲突的先登记方）；其余的显示为「内置功能 id」。 */
const builtinOwnerKeys: Readonly<Record<string, MessageKey>> = {
  shell: "plugins.owner.shell",
  projects: "plugins.owner.projects",
  workbench: "plugins.owner.workbench",
  settings: "plugins.owner.settings",
  agents: "plugins.owner.agents",
  schedules: "plugins.owner.schedules",
  plugins: "plugins.owner.plugins",
  toolRenderers: "plugins.owner.toolRenderers",
}

/** 界面代码错误的文案。 */
const clientErrorKeys: Record<PluginClientError["kind"], MessageKey> = {
  import: "plugins.clientError.import",
  apply: "plugins.clientError.apply",
  command: "plugins.clientError.command",
}

/** 详情对话框需要的状态与事件。 */
export interface PluginDetailsDialogProps {
  /** 要看的插件；null 时对话框关闭。 */
  plugin: PluginSummary | null
  /** 全部插件；扩展点冲突的另一方是插件时用它的显示名。 */
  plugins: readonly PluginSummary[]
  pending: boolean
  /** 打开时直接停在「确认卸载」上：在卡片的更多菜单里选了卸载。 */
  confirmUninstall?: boolean | undefined
  onClose: () => void
  /** 卸载用户安装的插件；缺省或内置插件时没有卸载按钮。 */
  onUninstall?: ((id: string) => void) | undefined
  /** 按来源重新安装；缺省、内置插件或不知道来源时没有更新按钮。 */
  onUpdate?: ((id: string) => void) | undefined
}

function DetailsBody({
  plugin,
  plugins,
  pending,
  confirmUninstall,
  onClose,
  onUninstall,
  onUpdate,
}: Omit<PluginDetailsDialogProps, "plugin"> & { plugin: PluginSummary }) {
  const { t, locale } = useLocale()
  const [confirming, setConfirming] = useState(confirmUninstall ?? false)
  const name = plugin.displayName ?? plugin.name
  const status = statusOf(plugin)
  const description = descriptionOf(plugin, locale)
  const showError = plugin.error !== null && plugin.error !== plugin.conflict
  const canUninstall = onUninstall !== undefined && !plugin.builtin
  const canUpdate = onUpdate !== undefined && !plugin.builtin && Boolean(plugin.origin)

  /** 一条扩展点冲突的说明，写明被拒绝的登记和先登记的一方。 */
  function conflictText(conflict: PluginContributionConflict): string {
    const other = plugins.find((item) => item.id === conflict.owner.id)
    const builtinKey = Object.hasOwn(builtinOwnerKeys, conflict.owner.id)
      ? builtinOwnerKeys[conflict.owner.id]
      : undefined
    const owner =
      conflict.owner.kind === "plugin"
        ? fill(t("plugins.owner.plugin"), {
            plugin: other?.displayName ?? other?.name ?? conflict.owner.id,
          })
        : builtinKey
          ? t(builtinKey)
          : fill(t("plugins.owner.builtin"), { id: conflict.owner.id })
    return fill(t("plugins.contributionConflict"), {
      point: t(pointKeys[conflict.point]),
      id: conflict.id,
      owner,
    })
  }

  return (
    <Dialog.Content
      className="plugin-dialog"
      closeLabel={t("common.close")}
      title={
        <>
          <EntityAvatar id={plugin.id} name={name} className="market-icon" />
          {name}
        </>
      }
      description={
        <span className="plugin-dialog-meta" data-tone={status.tone}>
          <StatusDot tone={status.tone} />
          <span>{t(status.label)}</span>
          <Badge>{t(kindKeys[plugin.kind])}</Badge>
          {plugin.builtin ? <Badge>{t("plugins.builtin")}</Badge> : null}
          <span className="plugin-dialog-version">{plugin.version}</span>
        </span>
      }
    >
      <Dialog.Body className="plugin-dialog-body">
        {description ? <p className="agent-description">{description}</p> : null}
        <dl className="ext-facts">
          <dt>{t("plugins.facts.package")}</dt>
          <dd className="mono">{plugin.name}</dd>
          <dt>{t("plugins.facts.kind")}</dt>
          <dd>{t(kindKeys[plugin.kind])}</dd>
          <dt>{t("plugins.facts.api")}</dt>
          <dd>{plugin.apiVersion}</dd>
          <dt>{t("plugins.permissions")}</dt>
          <dd>
            {plugin.permissions.length > 0
              ? plugin.permissions.map((permission) => (
                  <Badge key={permission} variant="warn">
                    {permission}
                  </Badge>
                ))
              : t("plugins.facts.none")}
          </dd>
          <dt>{t("plugins.facts.provides")}</dt>
          <dd className="mono">
            {plugin.provides.length > 0 ? plugin.provides.join(", ") : t("plugins.facts.none")}
          </dd>
          {plugin.originLabel ? (
            <>
              <dt>{t("plugins.facts.origin")}</dt>
              <dd className="mono">{plugin.originLabel}</dd>
            </>
          ) : null}
        </dl>
        {plugin.conflict ? (
          <p className="ext-error">
            {t("plugins.conflict")}: {plugin.conflict}
          </p>
        ) : null}
        {showError ? <p className="ext-error">{plugin.error}</p> : null}
        {plugin.clientErrors?.map((error, index) => (
          <p key={`${error.kind}:${index}`} className="ext-error">
            {fill(t(clientErrorKeys[error.kind]), { reason: error.detail })}
          </p>
        ))}
        {plugin.contributionConflicts?.map((conflict, index) => (
          <p key={`${conflict.point}:${conflict.id}:${index}`} className="ext-error">
            {conflictText(conflict)}
          </p>
        ))}
      </Dialog.Body>
      {canUninstall || canUpdate ? (
        <Dialog.Footer className="plugin-dialog-foot">
          {canUpdate && !confirming ? (
            <Button
              size="sm"
              type="button"
              disabled={pending}
              onClick={() => onUpdate?.(plugin.id)}
            >
              {pending ? t("plugins.updating") : t("plugins.update")}
            </Button>
          ) : null}
          {!canUninstall ? null : confirming ? (
            <>
              <span className="plugin-dialog-hint">{t("plugins.uninstallHint")}</span>
              <Button size="sm" variant="ghost" type="button" onClick={() => setConfirming(false)}>
                {t("agents.install.cancel")}
              </Button>
              <Button
                size="sm"
                variant="solidDanger"
                type="button"
                disabled={pending}
                onClick={() => {
                  onClose()
                  onUninstall?.(plugin.id)
                }}
              >
                {t("plugins.uninstallConfirm")}
              </Button>
            </>
          ) : (
            <Button
              size="sm"
              variant="danger"
              type="button"
              disabled={pending}
              onClick={() => setConfirming(true)}
            >
              {t("plugins.uninstall")}
            </Button>
          )}
        </Dialog.Footer>
      ) : null}
    </Dialog.Content>
  )
}

/** 渲染插件详情；关闭的动画里继续画最后看的那个插件，内容不会先变空。 */
export function PluginDetailsDialog({ plugin, ...props }: PluginDetailsDialogProps) {
  const [last, setLast] = useState(plugin)
  if (plugin !== null && plugin !== last) setLast(plugin)
  const shown = plugin ?? last
  return (
    <Dialog.Root
      open={plugin !== null}
      onOpenChange={(open) => {
        if (!open) props.onClose()
      }}
    >
      {shown ? <DetailsBody key={shown.id} plugin={shown} {...props} /> : null}
    </Dialog.Root>
  )
}
