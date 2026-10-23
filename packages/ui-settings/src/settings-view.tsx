// 设置视图：分区导航加通用、外观页面；Agent、定时任务与插件分区由应用容器注入。
import type { ReactNode } from "react"
import { useLocale, type AppearanceController } from "@pigcode/ui-primitives"
import { AppearancePage } from "./appearance-page"
import { GeneralPage } from "./general-page"
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
  /** Agent 分区的内容由应用容器注入（需要 RPC 连接）。 */
  agentsPage?: ReactNode | undefined
  /** 外壳侧栏已经提供分区导航时传 false，避免出现两套设置导航。 */
  showNav?: boolean
}

/** 按分区渲染设置内容。 */
export function SettingsView({
  section,
  onSection,
  onClose,
  appearance,
  pluginManager,
  schedulesPage,
  agentsPage,
  showNav = true,
}: SettingsViewProps) {
  const { t } = useLocale()
  return (
    <section className="view" style={{ flexDirection: "row" }} aria-label={t("settings.title")}>
      {showNav ? <SettingsNav section={section} onSection={onSection} onClose={onClose} /> : null}
      <div className="panel-scroll">
        {section === "general" ? <GeneralPage /> : null}
        {section === "appearance" ? <AppearancePage appearance={appearance} /> : null}
        {section === "providers" ? agentsPage : null}
        {section === "schedules" ? schedulesPage : null}
        {section === "plugins" ? pluginManager : null}
      </div>
    </section>
  )
}
