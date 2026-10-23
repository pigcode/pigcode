/** 面板布局按钮：最大化右侧面板、切换底部终端、切换右侧面板。 */
import { Maximize2, Minimize2, PanelBottom, PanelRight } from "lucide-react"
import { Button, formatShortcut } from "@pigcode/ui-primitives"

/** 布局按钮文案。 */
export interface PanelLayoutLabels {
  maximize: string
  restore: string
  terminal: string
  right: string
}

/** 默认中文文案。 */
export const DEFAULT_PANEL_LAYOUT_LABELS: PanelLayoutLabels = {
  maximize: "最大化面板",
  restore: "还原面板大小",
  terminal: "切换底部终端",
  right: "切换右侧面板",
}

/** 布局按钮属性；只传入的回调才渲染对应按钮。 */
export interface PanelLayoutControlsProps {
  rightOpen: boolean
  onToggleRight: () => void
  terminalOpen?: boolean
  onToggleTerminal?: () => void
  maximized?: boolean
  onToggleMaximize?: () => void
  /** 没有活动会话时按钮置灰。 */
  disabled?: boolean
  labels?: Partial<PanelLayoutLabels>
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
  labels: overrides,
}: PanelLayoutControlsProps) {
  const labels = { ...DEFAULT_PANEL_LAYOUT_LABELS, ...overrides }
  const maximizeLabel = maximized ? labels.restore : labels.maximize
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
          aria-label={labels.terminal}
          title={`${labels.terminal} ${formatShortcut("Ctrl+`")}`}
          aria-pressed={terminalOpen}
          disabled={disabled}
          onClick={onToggleTerminal}
        >
          <PanelBottom className="ic" aria-hidden="true" />
        </Button>
      ) : null}
      <Button
        variant="plain"
        size="icon"
        type="button"
        aria-label={labels.right}
        title={`${labels.right} ${formatShortcut("Mod+j")}`}
        aria-pressed={rightOpen}
        disabled={disabled}
        onClick={onToggleRight}
      >
        <PanelRight className="ic" aria-hidden="true" />
      </Button>
    </div>
  )
}
