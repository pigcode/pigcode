/**
 * 插件 DOM 内容的挂载点：侧栏面板与右栏标签共用。容器带 pg-root，插件的内容使用宿主的字体、
 * 颜色与 pg-* 组件样式；重画或移除前调用插件返回的清理函数。渲染出错时显示原因，不影响宿主。
 */
import { useEffect, useRef } from "react"
import type { ClientRender } from "@pigcode/plugin-sdk"

/** 挂载一段插件内容；kind 区分侧栏面板与右栏标签的排版。 */
export function PluginContentHost({
  id,
  render,
  kind,
}: {
  id: string
  render: ClientRender
  kind: "panel" | "surface"
}) {
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const container = ref.current
    if (!container) return undefined
    container.replaceChildren()
    let cleanup: void | (() => void)
    try {
      cleanup = render(container)
    } catch (error) {
      const message = document.createElement("p")
      message.className = "pg-error"
      message.textContent = error instanceof Error ? error.message : String(error)
      container.replaceChildren(message)
    }
    return () => {
      try {
        if (typeof cleanup === "function") cleanup()
      } finally {
        container.replaceChildren()
      }
    }
  }, [render])
  return <div ref={ref} className={`pg-root pg-${kind}`} data-plugin-content={id} />
}

/** 为侧栏插件面板提供挂载点。 */
export function PluginPanelHost({ panel }: { panel: { id: string; render: ClientRender } }) {
  return <PluginContentHost id={panel.id} render={panel.render} kind="panel" />
}
