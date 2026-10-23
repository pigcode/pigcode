// 插件列表：和 Agent 页同一种行——头像、名称、版本、状态与类型、启用开关；点开看包名、权限与卸载。
import { useState } from "react"
import { ChevronDown } from "lucide-react"
import {
  Badge,
  Button,
  EntityAvatar,
  Switch,
  useLocale,
  type MessageKey,
} from "@pigcode/ui-primitives"

/** 插件类型，与 Host 的 boot graph 保持一致。 */
export type PluginKind = "provider" | "capability" | "ui" | "bundle"

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
  /** 插件声明提供的能力标识，用于冲突检测与展示。 */
  provides: string[]
  /** 插件声明的贡献点，原样透传。 */
  contributes: Record<string, unknown>
  /** provides 冲突原因；无冲突时为 null。 */
  conflict: string | null
  error: string | null
}

/** 类型的本地化文案。 */
const kindKeys: Record<PluginKind, MessageKey> = {
  provider: "plugins.kind.provider",
  capability: "plugins.kind.capability",
  ui: "plugins.kind.ui",
  bundle: "plugins.kind.bundle",
}

/** 一行的状态：加载失败 > 冲突 > 启用 > 停用。 */
function statusOf(plugin: PluginSummary): { tone: string; label: MessageKey } {
  if (plugin.error && plugin.error !== plugin.conflict) {
    return { tone: "error", label: "plugins.status.failed" }
  }
  if (plugin.conflict) return { tone: "warning", label: "plugins.status.conflict" }
  return plugin.enabled
    ? { tone: "ready", label: "plugins.enabled" }
    : { tone: "off", label: "plugins.disabled" }
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
}

function PluginDetails({
  plugin,
  pending,
  onUninstall,
}: {
  plugin: PluginSummary
  pending: boolean
  onUninstall?: (() => void) | undefined
}) {
  const { t } = useLocale()
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
}: PluginListProps) {
  const { t } = useLocale()
  const [expanded, setExpanded] = useState<string | null>(null)

  return (
    <section className="section">
      <div className="section-head">
        <h2>{t("plugins.installed")}</h2>
      </div>
      {plugins.length === 0 ? (
        <div className="empty">{t("plugins.empty")}</div>
      ) : (
        <div className="group ext-list">
          {plugins.map((plugin) => {
            const name = plugin.displayName ?? plugin.name
            const open = expanded === plugin.id
            const pending = pendingId === plugin.id
            const status = statusOf(plugin)
            return (
              <div className="ext-item" key={plugin.id} data-plugin={plugin.name}>
                <div className="ext-row" data-expanded={open || undefined}>
                  <button
                    type="button"
                    className="ext-row-main"
                    aria-expanded={open}
                    aria-label={t("plugins.expand").replace("{plugin}", name)}
                    onClick={() => setExpanded(open ? null : plugin.id)}
                  >
                    <EntityAvatar id={plugin.id} name={name} />
                    <span className="ext-row-text">
                      <span className="ext-row-title">
                        <span className="truncate">{name}</span>
                        {plugin.builtin ? <Badge>{t("plugins.builtin")}</Badge> : null}
                        <span className="ext-version">{plugin.version}</span>
                      </span>
                      <span className="ext-row-status" data-tone={status.tone}>
                        <span className="ext-dot" aria-hidden="true" />
                        <span>{t(status.label)}</span>
                        <span className="ext-row-detail truncate">
                          · {t(kindKeys[plugin.kind])} · {plugin.name}
                        </span>
                      </span>
                    </span>
                    <ChevronDown className="ic ic-sm ext-chevron" aria-hidden="true" />
                  </button>
                  <Switch
                    aria-label={t("plugins.toggle").replace("{plugin}", name)}
                    checked={plugin.enabled}
                    disabled={pending}
                    onCheckedChange={(checked) =>
                      checked ? onEnable(plugin.id) : onDisable(plugin.id)
                    }
                  />
                </div>
                {open ? (
                  <PluginDetails
                    plugin={plugin}
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
