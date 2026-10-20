// 插件列表：名称、版本、类型、启用状态和错误，并提供启用/停用按钮。
import { Badge, Button, useLocale, type MessageKey } from "@pigcode/ui-primitives"

/** 插件类型，与 Host 的 boot graph 保持一致。 */
export type PluginKind = "provider" | "capability" | "ui" | "bundle"

/** 插件管理页展示的插件摘要。 */
export interface PluginSummary {
  id: string
  name: string
  version: string
  kind: PluginKind
  enabled: boolean
  error: string | null
}

/** 类型徽标的本地化文案。 */
const kindKeys: Record<PluginKind, MessageKey> = {
  provider: "plugins.kind.provider",
  capability: "plugins.kind.capability",
  ui: "plugins.kind.ui",
  bundle: "plugins.kind.bundle",
}

/** 插件列表需要的状态与事件。 */
export interface PluginListProps {
  plugins: PluginSummary[]
  /** 正在处理的插件 id，用于禁用按钮并显示处理中。 */
  pendingId: string | null
  onEnable: (id: string) => void
  onDisable: (id: string) => void
}

/** 渲染已安装插件；列表为空时显示空状态。 */
export function PluginList({ plugins, pendingId, onEnable, onDisable }: PluginListProps) {
  const { t } = useLocale()

  if (plugins.length === 0) {
    return <div className="empty">{t("plugins.empty")}</div>
  }

  return (
    <section className="section">
      <div className="section-head">
        <h2>{t("plugins.installed")}</h2>
      </div>
      <div className="group">
        {plugins.map((plugin) => {
          const pending = pendingId === plugin.id
          return (
            <div className="item" key={plugin.id}>
              <div className="main">
                <div className="ttl">
                  {plugin.name}
                  <Badge>{plugin.version}</Badge>
                  <Badge variant="info">{t(kindKeys[plugin.kind])}</Badge>
                  <Badge variant={plugin.enabled ? "ok" : "neutral"}>
                    {plugin.enabled ? t("plugins.enabled") : t("plugins.disabled")}
                  </Badge>
                </div>
                <div className="desc mono">{plugin.id}</div>
                {plugin.error ? <div className="desc error-text">{plugin.error}</div> : null}
              </div>
              <div className="trail">
                {plugin.enabled ? (
                  <Button
                    size="sm"
                    type="button"
                    disabled={pending}
                    onClick={() => onDisable(plugin.id)}
                  >
                    {pending ? t("plugins.working") : t("plugins.disable")}
                  </Button>
                ) : (
                  <Button
                    size="sm"
                    variant="primary"
                    type="button"
                    disabled={pending}
                    onClick={() => onEnable(plugin.id)}
                  >
                    {pending ? t("plugins.working") : t("plugins.enable")}
                  </Button>
                )}
              </div>
            </div>
          )
        })}
      </div>
    </section>
  )
}
