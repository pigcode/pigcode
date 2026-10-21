/** 右栏容器：Files/Diff/Terminal/Checkpoint/PR/Preview 六个 tab、内容区与关闭按钮。 */
import type { ReactNode } from "react"

/** 右栏 tab 的固定顺序。 */
export const RIGHT_PANEL_TABS = [
  "files",
  "diff",
  "terminal",
  "checkpoint",
  "pr",
  "preview",
] as const

/** 右栏 tab 标识。 */
export type RightPanelTab = (typeof RIGHT_PANEL_TABS)[number]

/** 右栏属性；tabs 的内容由容器组件按 threadId 从 RPC 数据组装。 */
export interface RightPanelProps {
  threadId: string
  tabs: Partial<Record<RightPanelTab, ReactNode>>
  active: RightPanelTab
  onTab: (tab: RightPanelTab) => void
  onClose?: () => void
  labels?: Partial<Record<RightPanelTab, string>>
}

/** 默认 tab 标题。 */
const DEFAULT_LABELS: Record<RightPanelTab, string> = {
  files: "Files",
  diff: "Diff",
  terminal: "Terminal",
  checkpoint: "Checkpoint",
  pr: "PR",
  preview: "Preview",
}

/** 右栏入口；tab 状态完全受控，关闭按钮仅在传入 onClose 时显示。 */
export function RightPanel({ threadId, tabs, active, onTab, onClose, labels }: RightPanelProps) {
  return (
    <aside className="right-panel" aria-label="工作台" data-thread-id={threadId}>
      <div className="right-panel-header">
        <div className="right-panel-tabs" role="tablist" aria-label="工作台视图">
          {RIGHT_PANEL_TABS.map((tab) => {
            const selected = tab === active
            return (
              <button
                key={tab}
                type="button"
                role="tab"
                id={`right-panel-tab-${tab}`}
                className={selected ? "right-panel-tab right-panel-tab-active" : "right-panel-tab"}
                aria-selected={selected}
                aria-controls={`right-panel-panel-${tab}`}
                onClick={() => onTab(tab)}
              >
                {labels?.[tab] ?? DEFAULT_LABELS[tab]}
              </button>
            )
          })}
        </div>
        {onClose ? (
          <button
            type="button"
            className="right-panel-close"
            aria-label="关闭右栏"
            title="关闭右栏"
            onClick={onClose}
          >
            ×
          </button>
        ) : null}
      </div>
      <div
        className="right-panel-body"
        role="tabpanel"
        id={`right-panel-panel-${active}`}
        aria-labelledby={`right-panel-tab-${active}`}
      >
        {tabs[active] ?? <p className="workbench-empty">暂无内容</p>}
      </div>
    </aside>
  )
}
