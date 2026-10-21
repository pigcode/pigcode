/** 设置侧栏：返回入口、搜索框与设置分区导航。 */
import { useState } from "react"
import { Button, Input, useLocale, type MessageKey } from "@pigcode/ui-primitives"
import { Icon } from "./icon"

/** 设置页的分区。 */
export type SettingsSection = "general" | "appearance" | "providers" | "schedules" | "plugins"

interface SettingsNavItem {
  id: SettingsSection
  icon: string
  labelKey: MessageKey
}

/** 分区顺序与 M0-B 计划保持一致；文案全部来自 locale。 */
const settingsNav: SettingsNavItem[] = [
  { id: "general", icon: "toggle", labelKey: "settings.general" },
  { id: "appearance", icon: "contrast", labelKey: "settings.appearance" },
  { id: "providers", icon: "server", labelKey: "settings.providers" },
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
      <Button variant="plain" className="nav-item back" type="button" onClick={onExit}>
        <Icon name="left" />
        {t("settings.back")}
      </Button>
      <label className="side-search">
        <Icon name="search" small />
        <Input
          type="search"
          placeholder={t("settings.search")}
          aria-label={t("settings.search")}
          autoComplete="off"
          spellCheck={false}
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Escape") setQuery("")
            const first = items[0]
            if (event.key === "Enter" && first) onSelect(first.id)
          }}
        />
        {query ? (
          <Button
            variant="plain"
            className="side-search-clear"
            type="button"
            aria-label={t("settings.clear")}
            onClick={() => setQuery("")}
          >
            <Icon name="x" small />
          </Button>
        ) : null}
      </label>
      {items.length === 0 ? <p className="side-empty-hit">{t("settings.noMatches")}</p> : null}
      <div className="side-group">{t("settings.title")}</div>
      {items.map((item) => {
        const active = item.id === activeSection
        return (
          <Button
            variant="plain"
            key={item.id}
            className={active ? "nav-item is-active" : "nav-item"}
            type="button"
            aria-current={active ? "page" : undefined}
            onClick={() => onSelect(item.id)}
          >
            <Icon name={item.icon} />
            {t(item.labelKey)}
          </Button>
        )
      })}
    </>
  )
}
