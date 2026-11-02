// 设置视图：按分区渲染通用、外观页面；Agent、定时任务与插件分区由应用容器注入。
// 分区导航在外壳的侧栏里（ui-shell 的 SettingsSidebar）。
import type { ReactNode } from "react"
import { useLocale, type AppearanceController } from "@pigcode/ui-primitives"
import { AppearancePage } from "./appearance-page"
import { GeneralPage } from "./general-page"

/** 设置页的分区。 */
export type SettingsSection = "general" | "appearance" | "agents" | "schedules" | "plugins"

/** 设置视图需要的状态。 */
export interface SettingsViewProps {
  section: SettingsSection
  /** 外观控制器由应用顶层持有，避免重复实例化。 */
  appearance?: AppearanceController | undefined
  /** 插件分区的内容由插件管理包注入。 */
  pluginManager?: ReactNode | undefined
  /** 定时任务分区的内容由应用容器注入（需要 RPC 连接）。 */
  schedulesPage?: ReactNode | undefined
  /** Agent 分区的内容由应用容器注入（需要 RPC 连接）。 */
  agentsPage?: ReactNode | undefined
}

/** 按分区渲染设置内容。 */
export function SettingsView({
  section,
  appearance,
  pluginManager,
  schedulesPage,
  agentsPage,
}: SettingsViewProps) {
  const { t } = useLocale()
  return (
    <section className="view" aria-label={t("settings.title")}>
      <div className="panel-scroll">
        {section === "general" ? <GeneralPage /> : null}
        {section === "appearance" ? <AppearancePage appearance={appearance} /> : null}
        {section === "agents" ? agentsPage : null}
        {section === "schedules" ? schedulesPage : null}
        {section === "plugins" ? pluginManager : null}
      </div>
    </section>
  )
}
