/**
 * 设置侧栏：返回和搜索入口固定在顶部，下面滚动的导航与搜索共享设置页扩展点。
 */
import { useMemo, type ReactNode } from "react"
import type { HostSummary } from "@pigcode/contracts"
import {
  contributionText,
  useContributions,
  type SettingsPageContribution,
} from "@pigcode/client-runtime"
import { EmptyState, HostPickerMenu, ListRow, useLocale } from "@pigcode/ui-primitives"
import { Icon } from "./icon"
import { SettingsSearch } from "./settings-search"
import { SideScroll } from "./side-scroll"

/** 设置侧栏需要的状态与事件；页面用设置页的 id 表示。 */
export interface SettingsSidebarProps {
  activePage: string
  onSelect: (page: string) => void
  onExit: () => void
  /** 多主机设置作用域：传入时将设置项分成「应用与连接」与「当前配置主机」。 */
  hosts?: readonly HostSummary[] | undefined
  settingsHostId?: string | undefined
  onSelectSettingsHost?: ((hostId: string) => void) | undefined
  /** 排在导航最后、跟着导航滚动的内容，例如插件的 Panel。 */
  children?: ReactNode
}

/** 绘制设置导航。 */
export function SettingsSidebar({
  activePage,
  onSelect,
  onExit,
  hosts,
  settingsHostId,
  onSelectSettingsHost,
  children,
}: SettingsSidebarProps) {
  const { t } = useLocale()
  const pages = useContributions("settingsPage")
  const [builtin, plugins] = useMemo(
    () => [
      pages.filter((page) => page.owner.kind === "builtin"),
      pages.filter((page) => page.owner.kind === "plugin"),
    ],
    [pages],
  )
  const scopedLayout = Boolean(hosts && hosts.length > 0 && settingsHostId && onSelectSettingsHost)
  const [appPages, hostPages] = useMemo(
    () => [
      builtin.filter((page) => page.owner.id !== "host-scope"),
      builtin.filter((page) => page.owner.id === "host-scope"),
    ],
    [builtin],
  )

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
        <SettingsSearch builtin={builtin} plugins={plugins} onSelect={onSelect} />
      </div>
      <SideScroll>
        {pages.length === 0 ? <EmptyState size="compact" title={t("settings.noMatches")} /> : null}
        {scopedLayout && hosts && settingsHostId && onSelectSettingsHost ? (
          <>
            <div className="side-group">{t("settings.group.app")}</div>
            {appPages.length > 0 ? (
              <nav className="side-nav" aria-label={t("settings.group.app")}>
                {appPages.map(row)}
              </nav>
            ) : null}
            <div className="settings-scope-card">
              <span className="settings-scope-label">{t("settings.hostScope.label")}</span>
              <HostPickerMenu
                hosts={hosts}
                value={settingsHostId}
                onChange={onSelectSettingsHost}
                className="settings-scope-trigger"
              />
            </div>
            {hostPages.length > 0 ? (
              <nav className="side-nav" aria-label={t("settings.group.host")}>
                {hostPages.map(row)}
              </nav>
            ) : null}
          </>
        ) : (
          <>
            <div className="side-group">{t("settings.title")}</div>
            {builtin.length > 0 ? (
              <nav className="side-nav" aria-label={t("settings.title")}>
                {builtin.map(row)}
              </nav>
            ) : null}
          </>
        )}
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
