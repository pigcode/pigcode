// 通用设置页：启动、更新和侧栏会话分组。
import {
  SettingPage,
  SettingRow,
  SettingSection,
  Switch,
  Toggle,
  ToggleGroup,
  useLocale,
  useSidebarGrouping,
  type SidebarGrouping,
} from "@pigcode/ui-primitives"

/** 渲染通用设置；启动与更新开关只在本页保留状态，侧栏排法保存在本机并同步到侧栏。 */
export function GeneralPage() {
  const { t } = useLocale()
  const [grouping, setGrouping] = useSidebarGrouping()

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
