/**
 * 设置侧栏：固定在上面的返回入口与搜索框，下面滚动的设置页导航。导航从设置页扩展点生成：内置的页在
 * 「设置」组，插件的页在「插件设置」组；搜索按当前语言的名称过滤这两组。
 */
import { useState, type ReactNode } from "react"
import {
  contributionText,
  useContributions,
  type SettingsPageContribution,
} from "@pigcode/client-runtime"
import { EmptyState, ListRow, SearchField, useLocale } from "@pigcode/ui-primitives"
import { Icon } from "./icon"
import { SideScroll } from "./side-scroll"

/** 设置侧栏需要的状态与事件；页面用设置页的 id 表示。 */
export interface SettingsSidebarProps {
  activePage: string
  onSelect: (page: string) => void
  onExit: () => void
  /** 排在导航最后、跟着导航滚动的内容，例如插件的 Panel。 */
  children?: ReactNode
}

/** 绘制设置导航；搜索只过滤导航，不改变当前页。 */
export function SettingsSidebar({ activePage, onSelect, onExit, children }: SettingsSidebarProps) {
  const { t } = useLocale()
  const pages = useContributions("settingsPage")
  const [query, setQuery] = useState("")
  const needle = query.trim().toLowerCase()
  const items = needle
    ? pages.filter((page) => contributionText(t, page.title).toLowerCase().includes(needle))
    : pages
  const builtin = items.filter((page) => page.owner.kind === "builtin")
  const plugins = items.filter((page) => page.owner.kind === "plugin")

  function row(page: SettingsPageContribution) {
    const active = page.id === activePage
    const PageIcon = page.icon
    return (
      <ListRow
        key={page.id}
        render={<button type="button" />}
        className="nav-item"
        selected={active}
        aria-current={active ? "page" : undefined}
        onClick={() => onSelect(page.id)}
        leading={<PageIcon className="ic" aria-hidden="true" />}
        title={contributionText(t, page.title)}
      />
    )
  }

  return (
    <>
      <div className="side-head">
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
            const first = builtin[0] ?? plugins[0]
            if (event.key === "Enter" && first) onSelect(first.id)
          }}
        />
      </div>
      <SideScroll>
        {items.length === 0 ? <EmptyState size="compact" title={t("settings.noMatches")} /> : null}
        {/* 搜索时没有匹配的内置页就不留空的组标题；不搜索时照常显示。 */}
        {builtin.length > 0 || !needle ? (
          <div className="side-group">{t("settings.title")}</div>
        ) : null}
        {builtin.length > 0 ? (
          <nav className="side-nav" aria-label={t("settings.title")}>
            {builtin.map(row)}
          </nav>
        ) : null}
        {plugins.length > 0 ? (
          <>
            <div className="side-group">{t("settings.pluginPages")}</div>
            <nav className="side-nav" aria-label={t("settings.pluginPages")}>
              {plugins.map(row)}
            </nav>
          </>
        ) : null}
        {children}
      </SideScroll>
    </>
  )
}
