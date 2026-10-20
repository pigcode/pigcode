/** 把 registerPanel 的 DOM 渲染函数挂到 React 生命周期。 */
import { useEffect, useRef } from "react"
import type { ClientPanel } from "@pigcode/plugin-sdk"

/** 为插件面板提供挂载点，并在面板变化时重新渲染。 */
export function PluginPanelHost({ panel }: { panel: ClientPanel }) {
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!ref.current) return
    panel.render(ref.current)
  }, [panel])
  return <div ref={ref} data-plugin-panel={panel.id} />
}
