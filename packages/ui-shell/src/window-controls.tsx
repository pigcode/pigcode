/**
 * 侧栏顶行的按钮：左边是侧栏开关，右边是搜索与前进后退。
 * 窗口按钮（macOS 交通灯、Windows/Linux 的最小化最大化关闭）由系统绘制，这里不画。
 * 侧栏收起后按钮仍固定在窗口左上角，挨在一起排进内容区的顶栏。
 */
import { Button, formatShortcut, isMacPlatform, useLocale } from "@pigcode/ui-primitives"
import { Icon } from "./icon"

/** 顶行按钮需要的状态与事件。 */
export interface WindowControlsProps {
  sidebarOpen: boolean
  canGoBack: boolean
  canGoForward: boolean
  onToggleSidebar: () => void
  onSearch: () => void
  onBack: () => void
  onForward: () => void
}

/** 绘制侧栏顶行按钮。 */
export function WindowControls({
  sidebarOpen,
  canGoBack,
  canGoForward,
  onToggleSidebar,
  onSearch,
  onBack,
  onForward,
}: WindowControlsProps) {
  const { t } = useLocale()
  const sidebarLabel = sidebarOpen ? t("sidebar.collapse") : t("sidebar.expand")
  const mac = isMacPlatform()
  const backKeys = mac ? formatShortcut("Mod+[") : "Alt+←"
  const forwardKeys = mac ? formatShortcut("Mod+]") : "Alt+→"
  return (
    <div className="window-controls">
      <Button
        variant="plain"
        className="icon-btn"
        type="button"
        aria-label={sidebarLabel}
        aria-expanded={sidebarOpen}
        title={`${sidebarLabel} ${formatShortcut("Mod+b")}`}
        onClick={onToggleSidebar}
      >
        <Icon name="sidebar" />
      </Button>
      <span className="window-controls-gap" />
      <Button
        variant="plain"
        className="icon-btn"
        type="button"
        aria-label={t("nav.search")}
        title={`${t("palette.placeholder")} ${formatShortcut("Mod+k")}`}
        onClick={onSearch}
      >
        <Icon name="search" />
      </Button>
      <Button
        variant="plain"
        className="icon-btn"
        type="button"
        aria-label={t("nav.back")}
        title={`${t("nav.back")} ${backKeys}`}
        disabled={!canGoBack}
        onClick={onBack}
      >
        <Icon name="arrow-left" />
      </Button>
      <Button
        variant="plain"
        className="icon-btn"
        type="button"
        aria-label={t("nav.forward")}
        title={`${t("nav.forward")} ${forwardKeys}`}
        disabled={!canGoForward}
        onClick={onForward}
      >
        <Icon name="arrow" />
      </Button>
    </div>
  )
}
