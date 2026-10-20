// 设置页分区导航：返回应用、分区标题与 M0-B 的四个设置分区。
import { Button, useLocale, type MessageKey } from "@pigcode/ui-primitives"

/** M0-B 设置页的分区；插件分区由插件管理视图单独渲染。 */
export type SettingsSection = "general" | "appearance" | "providers" | "plugins"

/** 一个导航条目；文案全部来自 locale。 */
export interface SettingsNavItem {
  id: SettingsSection
  labelKey: MessageKey
}

/** 分区顺序与 M0-B 计划保持一致。 */
export const settingsNavItems: readonly SettingsNavItem[] = [
  { id: "general", labelKey: "settings.general" },
  { id: "appearance", labelKey: "settings.appearance" },
  { id: "providers", labelKey: "settings.providers" },
  { id: "plugins", labelKey: "settings.plugins" },
]

/** 设置导航需要的状态与事件。 */
export interface SettingsNavProps {
  section: SettingsSection
  onSection: (section: SettingsSection) => void
  onClose: () => void
}

/** 渲染设置分区导航；当前分区用 aria-current 标记。 */
export function SettingsNav({ section, onSection, onClose }: SettingsNavProps) {
  const { t } = useLocale()
  return (
    <nav
      aria-label={t("settings.title")}
      style={{
        flex: "none",
        display: "flex",
        flexDirection: "column",
        width: 200,
        padding: "12px 8px",
        overflow: "auto",
        boxShadow: "inset -1px 0 0 var(--border-strong)",
      }}
    >
      <Button variant="plain" className="nav-item back" type="button" onClick={onClose}>
        {t("settings.back")}
      </Button>
      <div className="side-group">{t("settings.title")}</div>
      {settingsNavItems.map((item) => {
        const active = item.id === section
        return (
          <Button
            variant="plain"
            key={item.id}
            className={active ? "nav-item is-active" : "nav-item"}
            type="button"
            aria-current={active ? "page" : undefined}
            onClick={() => onSection(item.id)}
          >
            {t(item.labelKey)}
          </Button>
        )
      })}
    </nav>
  )
}
