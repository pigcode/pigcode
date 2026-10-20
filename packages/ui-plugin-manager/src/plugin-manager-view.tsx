// 插件管理视图：刷新按钮、安装表单和插件列表。
import { useState } from "react"
import { Button, useLocale } from "@pigcode/ui-primitives"
import { InstallForm } from "./install-form"
import { PluginList, type PluginSummary } from "./plugin-list"

/** 插件管理视图需要的状态与事件。 */
export interface PluginManagerViewProps {
  plugins: PluginSummary[]
  onInstall: (spec: string) => Promise<void>
  onEnable: (id: string) => Promise<void>
  onDisable: (id: string) => Promise<void>
  onRefresh: () => Promise<void>
}

/** 渲染插件管理页；启用/停用失败时在页面顶部提示。 */
export function PluginManagerView({
  plugins,
  onInstall,
  onEnable,
  onDisable,
  onRefresh,
}: PluginManagerViewProps) {
  const { t } = useLocale()
  const [pendingId, setPendingId] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  async function run(id: string, action: () => Promise<void>): Promise<void> {
    setPendingId(id)
    setError(null)
    try {
      await action()
    } catch {
      setError(t("plugins.actionFailed"))
    } finally {
      setPendingId(null)
    }
  }

  return (
    <section className="view" aria-label={t("plugins.title")}>
      <div className="panel-top">
        <span className="spacer" />
      </div>
      <div className="panel-scroll">
        <div className="page narrow settings-page">
          <header className="page-head">
            <div>
              <h1>{t("plugins.title")}</h1>
            </div>
            <div className="actions">
              <Button
                size="sm"
                type="button"
                disabled={pendingId === "refresh"}
                onClick={() => void run("refresh", onRefresh)}
              >
                {pendingId === "refresh" ? t("plugins.working") : t("plugins.refresh")}
              </Button>
            </div>
          </header>
          {error ? (
            <p className="error-text" role="alert">
              {error}
            </p>
          ) : null}
          <InstallForm onInstall={onInstall} />
          <PluginList
            plugins={plugins}
            pendingId={pendingId}
            onEnable={(id) => void run(id, () => onEnable(id))}
            onDisable={(id) => void run(id, () => onDisable(id))}
          />
        </div>
      </div>
    </section>
  )
}
