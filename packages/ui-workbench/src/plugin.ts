/** 右栏插件入口：把 RightPanel 注册到 panel.right slot。 */
import { createElement } from "react"
import type { SlotRegistry } from "@pigcode/client-runtime"
import { RightPanel, type RightPanelProps } from "./right-panel"

/** 右栏使用的 slot 名称。 */
export const RIGHT_PANEL_SLOT = "panel.right"

/** 注册右栏；宿主通过 slot props 提供 tabs、active 与回调，返回注销函数。 */
export function registerRightPanel(registry: SlotRegistry): () => void {
  return registry.register<RightPanelProps>(RIGHT_PANEL_SLOT, {
    id: "workbench.right-panel",
    order: 0,
    render: (props) => createElement(RightPanel, props),
  })
}
