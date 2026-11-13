/** 面板布局按钮：最大化右侧面板、切换底部终端、切换右侧面板。 */
import { Maximize2, Minimize2, PanelBottom, PanelRight } from "lucide-react"
import { Button, formatShortcut, useLocale } from "@pigcode/ui-primitives"

/** 布局按钮属性；只传入的回调才渲染对应按钮。 */
export interface PanelLayoutControlsProps {
  rightOpen: boolean
  onToggleRight?: (() => void) | undefined
  terminalOpen?: boolean
  onToggleTerminal?: (() => void) | undefined
  maximized?: boolean
  onToggleMaximize?: () => void
  /** 没有活动会话时按钮置灰。 */
  disabled?: boolean
}

/** 一组切换按钮；聊天头部与右侧面板标签栏共用。 */
export function PanelLayoutControls({
  rightOpen,
  onToggleRight,
  terminalOpen = false,
  onToggleTerminal,
  maximized = false,
  onToggleMaximize,
  disabled = false,
}: PanelLayoutControlsProps) {
  const { t } = useLocale()
  const maximizeLabel = maximized ? t("panel.restore") : t("panel.maximize")
  const terminalLabel = t("panel.toggleTerminal")
  const rightLabel = t("panel.toggleRight")
  return (
    <div className="layout-controls" role="group">
      {onToggleMaximize ? (
        <Button
          variant="plain"
          size="icon"
          type="button"
          aria-label={maximizeLabel}
          title={maximizeLabel}
          aria-pressed={maximized}
          disabled={disabled}
          onClick={onToggleMaximize}
        >
          {maximized ? (
            <Minimize2 className="ic" aria-hidden="true" />
          ) : (
            <Maximize2 className="ic" aria-hidden="true" />
          )}
        </Button>
      ) : null}
      {onToggleTerminal ? (
        <Button
          variant="plain"
          size="icon"
          type="button"
          aria-label={terminalLabel}
          title={`${terminalLabel} ${formatShortcut("Ctrl+`")}`}
          aria-pressed={terminalOpen}
          disabled={disabled}
          onClick={onToggleTerminal}
        >
          <PanelBottom className="ic" aria-hidden="true" />
        </Button>
      ) : null}
      {onToggleRight ? (
        <Button
          variant="plain"
          size="icon"
          type="button"
          aria-label={rightLabel}
          title={`${rightLabel} ${formatShortcut("Mod+j")}`}
          aria-pressed={rightOpen}
          disabled={disabled}
          onClick={onToggleRight}
        >
          <PanelRight className="ic" aria-hidden="true" />
        </Button>
      ) : null}
    </div>
  )
}
