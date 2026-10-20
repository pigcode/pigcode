/** 固定在窗口左上角的侧栏开关与前进后退。 */
import { Button, useLocale } from "@pigcode/ui-primitives"
import { Icon } from "./icon"
import { TrafficLights } from "./traffic-lights"

/** 窗口按钮需要的状态与事件。 */
export interface WindowControlsProps {
  sidebarOpen: boolean
  canGoBack: boolean
  canGoForward: boolean
  onToggleSidebar: () => void
  onBack: () => void
  onForward: () => void
}

/** 绘制侧栏开关和前进后退；侧栏收起后按钮仍留在原位。 */
export function WindowControls({
  sidebarOpen,
  canGoBack,
  canGoForward,
  onToggleSidebar,
  onBack,
  onForward,
}: WindowControlsProps) {
  const { t } = useLocale()
  const sidebarLabel = sidebarOpen ? t("sidebar.collapse") : t("sidebar.expand")
  return (
    <div className="window-controls">
      <TrafficLights />
      <Button
        variant="plain"
        className="icon-btn"
        type="button"
        aria-label={sidebarLabel}
        aria-expanded={sidebarOpen}
        title={`${sidebarLabel} ⌘\\`}
        onClick={onToggleSidebar}
      >
        <Icon name="sidebar" />
      </Button>
      <Button
        variant="plain"
        className="icon-btn"
        type="button"
        aria-label={t("nav.back")}
        title={`${t("nav.back")} ⌘[`}
        disabled={!canGoBack}
        onClick={onBack}
      >
        <Icon name="left" />
      </Button>
      <Button
        variant="plain"
        className="icon-btn"
        type="button"
        aria-label={t("nav.forward")}
        title={`${t("nav.forward")} ⌘]`}
        disabled={!canGoForward}
        onClick={onForward}
      >
        <Icon name="right" />
      </Button>
    </div>
  )
}
