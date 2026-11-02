/** 设置侧栏：返回入口、搜索框与设置分区导航。 */
import { useState } from "react"
import {
  EmptyState,
  ListRow,
  SearchField,
  useLocale,
  type MessageKey,
} from "@pigcode/ui-primitives"
import { Icon } from "./icon"

/** 设置页的分区。 */
export type SettingsSection = "general" | "appearance" | "agents" | "schedules" | "plugins"

interface SettingsNavItem {
  id: SettingsSection
  icon: string
  labelKey: MessageKey
}

/** 分区顺序与 M0-B 计划保持一致；文案全部来自 locale。 */
const settingsNav: SettingsNavItem[] = [
  { id: "general", icon: "toggle", labelKey: "settings.general" },
  { id: "appearance", icon: "contrast", labelKey: "settings.appearance" },
  { id: "agents", icon: "server", labelKey: "settings.agents" },
  { id: "schedules", icon: "clock", labelKey: "settings.schedules" },
  { id: "plugins", icon: "cube", labelKey: "settings.plugins" },
]

/** 设置侧栏需要的状态与事件。 */
export interface SettingsSidebarProps {
  activeSection: SettingsSection
  onSelect: (section: SettingsSection) => void
  onExit: () => void
}

/** 绘制设置导航；搜索只过滤导航，不改变当前分区。 */
export function SettingsSidebar({ activeSection, onSelect, onExit }: SettingsSidebarProps) {
  const { t } = useLocale()
  const [query, setQuery] = useState("")
  const needle = query.trim().toLowerCase()
  const items = needle
    ? settingsNav.filter((item) => t(item.labelKey).toLowerCase().includes(needle))
    : settingsNav
  return (
    <>
      <ListRow
        render={<button type="button" />}
        className="nav-item back"
        onClick={onExit}
        leading={<Icon name="left" />}
        title={t("settings.back")}
      />
      <SearchField
        className="side-search"
        value={query}
        onValueChange={setQuery}
        placeholder={t("settings.search")}
        clearLabel={t("settings.clear")}
        onKeyDown={(event) => {
          if (event.key === "Escape") setQuery("")
          const first = items[0]
          if (event.key === "Enter" && first) onSelect(first.id)
        }}
      />
      {items.length === 0 ? <EmptyState size="compact" title={t("settings.noMatches")} /> : null}
      <div className="side-group">{t("settings.title")}</div>
      {items.map((item) => {
        const active = item.id === activeSection
        return (
          <ListRow
            key={item.id}
            render={<button type="button" />}
            className="nav-item"
            selected={active}
            aria-current={active ? "page" : undefined}
            onClick={() => onSelect(item.id)}
            leading={<Icon name={item.icon} />}
            title={t(item.labelKey)}
          />
        )
      })}
    </>
  )
}
