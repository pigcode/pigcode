// 插件管理视图：和 Agent 页同样的页面外框，标题栏右边是刷新与安装，下面是插件列表。
import { useState } from "react"
import { Plus, RefreshCw } from "lucide-react"
import { Button, InstallDialog, SettingPage, useLocale } from "@pigcode/ui-primitives"
import { PluginList, type PluginSummary } from "./plugin-list"

/** 插件管理视图需要的状态与事件；操作失败时抛错，页面展示原因。 */
export interface PluginManagerViewProps {
  plugins: PluginSummary[]
  onInstall: (spec: string) => Promise<void>
  onEnable: (id: string) => Promise<void>
  onDisable: (id: string) => Promise<void>
  /** 卸载用户安装的插件；缺省时不显示卸载按钮。 */
  onUninstall?: ((id: string) => Promise<void>) | undefined
  onRefresh: () => Promise<void>
  /** 选择本地插件目录；没有时安装对话框不显示「选择文件夹」。 */
  onPickFolder?: (() => Promise<string | null>) | undefined
}

/** 渲染插件管理页。 */
export function PluginManagerView({
  plugins,
  onInstall,
  onEnable,
  onDisable,
  onUninstall,
  onRefresh,
  onPickFolder,
}: PluginManagerViewProps) {
  const { t } = useLocale()
  const [pendingId, setPendingId] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [installOpen, setInstallOpen] = useState(false)

  async function run(id: string, action: () => Promise<void>): Promise<void> {
    setPendingId(id)
    setError(null)
    try {
      await action()
    } catch (reason) {
      const message = reason instanceof Error ? reason.message : String(reason)
      setError(t("plugins.failed").replace("{reason}", message))
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
        <SettingPage
          title={t("plugins.title")}
          sub={t("plugins.sub")}
          actions={
            <>
              <Button
                size="sm"
                type="button"
                disabled={pendingId === "refresh"}
                onClick={() => void run("refresh", onRefresh)}
              >
                <RefreshCw
                  className={pendingId === "refresh" ? "ic ic-sm spin" : "ic ic-sm"}
                  aria-hidden="true"
                />
                {t("plugins.refresh")}
              </Button>
              <Button
                size="sm"
                variant="primary"
                type="button"
                onClick={() => setInstallOpen(true)}
              >
                <Plus className="ic ic-sm" aria-hidden="true" />
                {t("plugins.install")}
              </Button>
            </>
          }
        >
          {error ? (
            <p className="error-text" role="alert">
              {error}
            </p>
          ) : null}
          <PluginList
            plugins={plugins}
            pendingId={pendingId}
            onEnable={(id) => void run(id, () => onEnable(id))}
            onDisable={(id) => void run(id, () => onDisable(id))}
            {...(onUninstall
              ? { onUninstall: (id: string) => void run(id, () => onUninstall(id)) }
              : {})}
          />
        </SettingPage>
      </div>
      <InstallDialog
        open={installOpen}
        onOpenChange={setInstallOpen}
        onInstall={onInstall}
        inputId="plugin-install-spec"
        labels={{
          title: t("plugins.install.title"),
          description: t("plugins.install.description"),
          spec: t("plugins.installSpec"),
          placeholder: t("plugins.installSpecPlaceholder"),
          chooseFolder: t("agents.install.chooseFolder"),
          trust: t("plugins.trustWarning"),
          cancel: t("agents.install.cancel"),
          submit: t("plugins.install.submit"),
          installing: t("plugins.installing"),
          failed: t("plugins.failed"),
        }}
        onPickFolder={onPickFolder}
      />
    </section>
  )
}
