// 设置视图：分区导航加通用、外观、服务提供方页面，插件分区可注入插件管理视图。
import type { ReactNode } from "react"
import { useLocale, type AppearanceController } from "@pigcode/ui-primitives"
import { AppearancePage } from "./appearance-page"
import { GeneralPage } from "./general-page"
import { ProviderPage, type ProviderDetection, type ProviderStatus } from "./provider-page"
import { SettingsNav, type SettingsSection } from "./settings-nav"

/** 设置视图需要的状态与事件。 */
export interface SettingsViewProps {
  section: SettingsSection
  onSection: (section: SettingsSection) => void
  onClose: () => void
  /** 外观控制器由应用顶层持有，避免重复实例化。 */
  appearance?: AppearanceController | undefined
  /** 插件分区的内容由插件管理包注入。 */
  pluginManager?: ReactNode | undefined
  /** 定时任务分区的内容由应用容器注入（需要 RPC 连接）。 */
  schedulesPage?: ReactNode | undefined
  /** Claude/Codex 检测结果；由应用容器注入。 */
  providers?: ProviderStatus[] | undefined
  /** 兼容旧的单 provider 检测结果。 */
  detection?: ProviderDetection | null | undefined
  /** 重新运行只读检测。 */
  onDetect?: (() => void | Promise<void>) | undefined
}

/** 按分区渲染设置内容。 */
export function SettingsView({
  section,
  onSection,
  onClose,
  appearance,
  pluginManager,
  schedulesPage,
  providers,
  detection,
  onDetect,
}: SettingsViewProps) {
  const { t } = useLocale()
  return (
    <section className="view" style={{ flexDirection: "row" }} aria-label={t("settings.title")}>
      <SettingsNav section={section} onSection={onSection} onClose={onClose} />
      <div className="panel-scroll">
        {section === "general" ? <GeneralPage /> : null}
        {section === "appearance" ? <AppearancePage appearance={appearance} /> : null}
        {section === "providers" ? (
          <ProviderPage providers={providers} detection={detection} onDetect={onDetect} />
        ) : null}
        {section === "schedules" ? schedulesPage : null}
        {section === "plugins" ? pluginManager : null}
      </div>
    </section>
  )
}
