// 通用设置页：启动、更新和侧栏会话分组。
import { useEffect, useRef, useState } from "react"
import {
  SegmentedControl,
  SettingPage,
  SettingRow,
  SettingSection,
  Switch,
  useLocale,
  useSidebarGrouping,
  type SidebarGrouping,
} from "@pigcode/ui-primitives"

/** 主进程要应用的偏好：开机自启与 Dock 图标。 */
interface Preferences {
  launchAtLogin: boolean
  showInDock: boolean
}

/** 本机桥只暴露需要的一小块，设置页不依赖主应用的全局类型。 */
interface VersionBridge {
  appVersion?: () => Promise<string>
  platform?: string
  getPreferences?: () => Promise<Preferences>
  setPreference?: (key: keyof Preferences, value: boolean) => Promise<Preferences>
}

function nativeBridge(): VersionBridge | undefined {
  return (globalThis as { pigcodeNative?: VersionBridge }).pigcodeNative
}

/** 从主进程读应用版本；读不到时保持空，不显示占位。 */
function useAppVersion(): string | null {
  const [version, setVersion] = useState<string | null>(null)
  useEffect(() => {
    void nativeBridge()
      ?.appVersion?.()
      .then(setVersion, () => undefined)
  }, [])
  return version
}

/** 读主进程的偏好；读到之前用默认值，开关不会在加载时闪一下。 */
function usePreferences(): [Preferences, (key: keyof Preferences, value: boolean) => void] {
  const [prefs, setPrefs] = useState<Preferences>({ launchAtLogin: false, showInDock: true })
  // 用户已经动过开关时，晚到的读取结果不能把刚改的值盖回去。
  const changed = useRef(false)
  useEffect(() => {
    void nativeBridge()
      ?.getPreferences?.()
      .then(
        (loaded) => {
          if (!changed.current) setPrefs(loaded)
        },
        () => undefined,
      )
  }, [])
  const update = (key: keyof Preferences, value: boolean): void => {
    changed.current = true
    setPrefs((current) => ({ ...current, [key]: value }))
    void nativeBridge()
      ?.setPreference?.(key, value)
      .then(setPrefs, () => undefined)
  }
  return [prefs, update]
}

/** 渲染通用设置；启动与更新开关只在本页保留状态，侧栏排法保存在本机并同步到侧栏。 */
export function GeneralPage() {
  const { t } = useLocale()
  const [grouping, setGrouping] = useSidebarGrouping()
  const version = useAppVersion()
  const [prefs, setPreference] = usePreferences()
  const platform = nativeBridge()?.platform

  return (
    <SettingPage title={t("settings.general.pageTitle")}>
      <SettingSection title={t("settings.general.startup")}>
        {/* Linux 上不显示开机自启，Dock 图标只在 macOS 上有。 */}
        {platform === "linux" ? null : (
          <SettingRow
            title={t("settings.general.launchAtLogin")}
            description={t("settings.general.launchAtLogin.description")}
          >
            <Switch
              checked={prefs.launchAtLogin}
              onCheckedChange={(value) => setPreference("launchAtLogin", value)}
              aria-label={t("settings.general.launchAtLogin")}
            />
          </SettingRow>
        )}
        {platform === "darwin" ? (
          <SettingRow
            title={t("settings.general.showInDock")}
            description={t("settings.general.showInDock.description")}
          >
            <Switch
              checked={prefs.showInDock}
              onCheckedChange={(value) => setPreference("showInDock", value)}
              aria-label={t("settings.general.showInDock")}
            />
          </SettingRow>
        ) : null}
      </SettingSection>
      <SettingSection title={t("settings.general.updates")}>
        <SettingRow
          title={t("settings.general.autoUpdate")}
          description={
            version
              ? t("settings.general.autoUpdate.description").replace("{version}", version)
              : undefined
          }
        >
          <Switch defaultChecked aria-label={t("settings.general.autoUpdate")} />
        </SettingRow>
      </SettingSection>
      <SettingSection title={t("settings.general.sidebar")}>
        <SettingRow title={t("settings.general.sidebarGrouping")}>
          <SegmentedControl<SidebarGrouping>
            aria-label={t("settings.general.sidebarGrouping")}
            value={grouping}
            onValueChange={setGrouping}
            options={[
              { value: "project", label: t("settings.general.byProject") },
              { value: "time", label: t("settings.general.byTime") },
            ]}
          />
        </SettingRow>
      </SettingSection>
      <SettingSection title={t("settings.about")}>
        <SettingRow
          title={t("settings.about.description")}
          value={version ? `${t("settings.about.version")} ${version}` : undefined}
        />
      </SettingSection>
    </SettingPage>
  )
}
