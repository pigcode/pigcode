// 插件列表：和 Agent 页同一种行——头像、名称、版本、状态与类型、启用开关；点开看包名、权限与卸载。
import { useState } from "react"
import { Box, ChevronDown, Plus } from "lucide-react"
import {
  Badge,
  Button,
  EmptyState,
  EntityAvatar,
  ListRow,
  StatusDot,
  Switch,
  useLocale,
  type MessageKey,
  type StatusTone,
} from "@pigcode/ui-primitives"

/** 插件类型，与 Host 的 boot graph 保持一致。 */
export type PluginKind = "agent" | "capability" | "ui" | "bundle"

/** 扩展点名称，与 client-runtime 的 ExtensionPoint 一致。 */
export type PluginExtensionPoint = "panel" | "surface" | "settingsPage" | "command" | "toolRenderer"

/** 插件在某个扩展点上被拒绝的一次登记：id 已经属于 owner。 */
export interface PluginContributionConflict {
  point: PluginExtensionPoint
  id: string
  owner: { kind: "builtin" | "plugin"; id: string }
}

/** 插件的界面代码在窗口里出的错：没有加载成功，或 apply 抛了错。detail 是原因。 */
export interface PluginClientError {
  kind: "import" | "apply"
  detail: string
}

/** 插件管理页展示的插件摘要；字段与 Host 的 PluginSummary 对齐。 */
export interface PluginSummary {
  id: string
  name: string
  /** manifest 的 displayName；旧 Host 没有这个字段时用包名。 */
  displayName?: string
  description?: string | null
  version: string
  kind: PluginKind
  enabled: boolean
  /** 随应用内置：可以停用，不能卸载。 */
  builtin?: boolean
  /** manifest 声明的 API 版本；manifest 不可用时为 0。 */
  apiVersion: number
  /** 安装时需要展示给用户的权限列表。 */
  permissions: string[]
  /** 插件声明提供的服务标识，用于冲突检测与展示。 */
  provides: string[]
  /** 插件声明的贡献点，原样透传。 */
  contributes: Record<string, unknown>
  /** provides 冲突原因；无冲突时为 null。 */
  conflict: string | null
  error: string | null
  /** 窗口里扩展点登记的冲突；由宿主从扩展点注册表填入，Host 的列表里没有。 */
  contributionConflicts?: readonly PluginContributionConflict[]
  /** 窗口里界面代码出的错；由宿主的插件控制器填入。 */
  clientErrors?: readonly PluginClientError[]
}

/** 类型的本地化文案。 */
const kindKeys: Record<PluginKind, MessageKey> = {
  agent: "plugins.kind.agent",
  capability: "plugins.kind.capability",
  ui: "plugins.kind.ui",
  bundle: "plugins.kind.bundle",
}

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
  workbench: "plugins.owner.workbench",
}

/** 界面代码错误的文案。 */
const clientErrorKeys: Record<PluginClientError["kind"], MessageKey> = {
  import: "plugins.clientError.import",
  apply: "plugins.clientError.apply",
}

/** 一次替换模板里的全部 {name}：替换进去的值原样显示，不会再被当成占位符或 $ 替换模式。 */
function fill(template: string, values: Readonly<Record<string, string>>): string {
  return template.replace(/\{(\w+)\}/g, (match, name: string) =>
    Object.hasOwn(values, name) ? (values[name] ?? match) : match,
  )
}

/** 一行的状态：加载失败 > 冲突 > 启用 > 停用。 */
function statusOf(plugin: PluginSummary): { tone: StatusTone; label: MessageKey } {
  if (
    (plugin.error && plugin.error !== plugin.conflict) ||
    (plugin.clientErrors?.length ?? 0) > 0
  ) {
    return { tone: "error", label: "plugins.status.failed" }
  }
  if (plugin.conflict || (plugin.contributionConflicts?.length ?? 0) > 0) {
    return { tone: "warning", label: "plugins.status.conflict" }
  }
  return plugin.enabled
    ? { tone: "ready", label: "plugins.enabled" }
    : { tone: "idle", label: "plugins.disabled" }
}

/** 插件列表需要的状态与事件。 */
export interface PluginListProps {
  plugins: PluginSummary[]
  /** 正在处理的插件 id，用于禁用开关与按钮。 */
  pendingId: string | null
  onEnable: (id: string) => void
  onDisable: (id: string) => void
  /** 卸载用户安装的插件；内置插件不显示卸载按钮。 */
  onUninstall?: ((id: string) => void) | undefined
  /** 打开安装对话框；给了它，列表为空时空状态里出现「安装插件」。 */
  onInstall?: (() => void) | undefined
}

function PluginDetails({
  plugin,
  plugins,
  pending,
  onUninstall,
}: {
  plugin: PluginSummary
  /** 全部插件；冲突的另一方是插件时用它的显示名。 */
  plugins: readonly PluginSummary[]
  pending: boolean
  onUninstall?: (() => void) | undefined
}) {
  const { t } = useLocale()

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

  const [confirming, setConfirming] = useState(false)
  const showError = plugin.error !== null && plugin.error !== plugin.conflict
  return (
    <div className="ext-details">
      {plugin.description ? <p className="agent-description">{plugin.description}</p> : null}
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
      {onUninstall ? (
        <div className="ext-actions">
          {confirming ? (
            <Button
              size="sm"
              variant="danger"
              type="button"
              disabled={pending}
              onClick={() => {
                setConfirming(false)
                onUninstall()
              }}
            >
              {t("plugins.uninstallConfirm")}
            </Button>
          ) : (
            <Button
              size="sm"
              variant="ghost"
              type="button"
              disabled={pending}
              onClick={() => setConfirming(true)}
            >
              {t("plugins.uninstall")}
            </Button>
          )}
        </div>
      ) : null}
    </div>
  )
}

/** 渲染已安装的插件；列表为空时显示空状态。 */
export function PluginList({
  plugins,
  pendingId,
  onEnable,
  onDisable,
  onUninstall,
  onInstall,
}: PluginListProps) {
  const { t } = useLocale()
  const [expanded, setExpanded] = useState<string | null>(null)

  return (
    <section className="section">
      <div className="section-head">
        <h2>{t("plugins.installed")}</h2>
      </div>
      {plugins.length === 0 ? (
        <EmptyState
          className="group"
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
      ) : (
        <div className="group ext-list">
          {plugins.map((plugin) => {
            const name = plugin.displayName ?? plugin.name
            const open = expanded === plugin.id
            const pending = pendingId === plugin.id
            const status = statusOf(plugin)
            return (
              <div className="ext-item" key={plugin.id} data-plugin={plugin.name}>
                <ListRow
                  className="ext-row"
                  data-expanded={open || undefined}
                  button={{
                    className: "ext-row-main",
                    "aria-expanded": open,
                    "aria-label": t("plugins.expand").replace("{plugin}", name),
                    onClick: () => setExpanded(open ? null : plugin.id),
                  }}
                  leading={<EntityAvatar id={plugin.id} name={name} />}
                  title={
                    <span className="ext-row-title">
                      <span className="truncate">{name}</span>
                      {plugin.builtin ? <Badge>{t("plugins.builtin")}</Badge> : null}
                      <span className="ext-version">{plugin.version}</span>
                    </span>
                  }
                  description={
                    <span className="ext-row-status" data-tone={status.tone}>
                      <StatusDot tone={status.tone} />
                      <span>{t(status.label)}</span>
                      <span className="ext-row-detail truncate">
                        · {t(kindKeys[plugin.kind])} · {plugin.name}
                      </span>
                    </span>
                  }
                  meta={<ChevronDown className="ic ic-sm ext-chevron" aria-hidden="true" />}
                  actions={
                    <Switch
                      aria-label={t("plugins.toggle").replace("{plugin}", name)}
                      checked={plugin.enabled}
                      disabled={pending}
                      onCheckedChange={(checked) =>
                        checked ? onEnable(plugin.id) : onDisable(plugin.id)
                      }
                    />
                  }
                />
                {open ? (
                  <PluginDetails
                    plugin={plugin}
                    plugins={plugins}
                    pending={pending}
                    onUninstall={
                      onUninstall && !plugin.builtin ? () => onUninstall(plugin.id) : undefined
                    }
                  />
                ) : null}
              </div>
            )
          })}
        </div>
      )}
    </section>
  )
}
