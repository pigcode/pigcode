// 通用设置页：启动、更新和侧栏会话分组。
import { useState } from "react"
import { Switch, Toggle, ToggleGroup, useLocale } from "@pigcode/ui-primitives"
import { SettingPage, SettingRow, SettingSection } from "./settings-page"

/** 侧栏会话的分组方式。 */
type SidebarGrouping = "project" | "time"

/** 渲染通用设置；M0-B 只在本地保留开关状态。 */
export function GeneralPage() {
  const { t } = useLocale()
  const [grouping, setGrouping] = useState<SidebarGrouping>("project")

  return (
    <SettingPage title={t("settings.general.pageTitle")}>
      <SettingSection title={t("settings.general.startup")}>
        <SettingRow
          title={t("settings.general.launchAtLogin")}
          description={t("settings.general.launchAtLogin.description")}
        >
          <Switch defaultChecked aria-label={t("settings.general.launchAtLogin")} />
        </SettingRow>
        <SettingRow
          title={t("settings.general.showInDock")}
          description={t("settings.general.showInDock.description")}
        >
          <Switch aria-label={t("settings.general.showInDock")} />
        </SettingRow>
      </SettingSection>
      <SettingSection title={t("settings.general.updates")}>
        <SettingRow
          title={t("settings.general.autoUpdate")}
          description={t("settings.general.autoUpdate.description")}
        >
          <Switch defaultChecked aria-label={t("settings.general.autoUpdate")} />
        </SettingRow>
      </SettingSection>
      <SettingSection title={t("settings.general.sidebar")}>
        <SettingRow title={t("settings.general.sidebarGrouping")}>
          <ToggleGroup<SidebarGrouping>
            multiple={false}
            value={[grouping]}
            onValueChange={(next) => {
              const value = next[0]
              if (value) setGrouping(value)
            }}
          >
            <Toggle value="project">{t("settings.general.byProject")}</Toggle>
            <Toggle value="time">{t("settings.general.byTime")}</Toggle>
          </ToggleGroup>
        </SettingRow>
      </SettingSection>
      <SettingSection title={t("settings.about")}>
        <SettingRow
          title={t("settings.about.description")}
          value={`${t("settings.about.version")} 0.1.0`}
        />
      </SettingSection>
    </SettingPage>
  )
}
