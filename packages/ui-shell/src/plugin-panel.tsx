/**
 * 左侧栏的 Panel，以及插件 DOM 内容的挂载点。Panel 从扩展点注册表读取；插件内容的挂载点由 Panel、
 * Surface、设置页与工具渲染器共用：容器带 pg-root，插件的内容使用宿主的字体、颜色与 pg-* 组件样式；
 * 重画或移除前调用插件返回的清理函数。渲染或清理出错时不影响宿主：渲染的错误显示在内容区，清理的错误写进控制台。
 */
import { useEffect, useRef, useState } from "react"
import { ChevronRight } from "lucide-react"
import { contributionText, useContributions, type PanelContribution } from "@pigcode/client-runtime"
import type { ClientRender } from "@pigcode/plugin-sdk"
import { useLocale } from "@pigcode/ui-primitives"

/** 挂载一段插件内容；kind 区分侧栏面板、右栏标签、设置页与时间线工具行的排版。render 换了就重画。 */
export function PluginContentHost({
  id,
  render,
  kind,
}: {
  id: string
  render: ClientRender
  kind: "panel" | "surface" | "settings" | "tool"
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
      } catch (error) {
        // 这里抛出去的话 React 会卸载外层的整棵树，时间线和侧栏都会跟着消失。
        console.error(`[plugin-content:${id}]`, error)
      } finally {
        container.replaceChildren()
      }
    }
  }, [render])
  return <div ref={ref} className={`pg-root pg-${kind}`} data-plugin-content={id} />
}

/** 侧栏里的一个 Panel：和「项目」同样的分组标题，点击收起或展开。 */
function SidebarPanel({ panel }: { panel: PanelContribution }) {
  const { t } = useLocale()
  const [open, setOpen] = useState(true)
  return (
    <section className="proj-block plugin-panel" data-open={open || undefined}>
      <button
        type="button"
        className="side-label plugin-panel-head"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
      >
        <span className="truncate">{contributionText(t, panel.title)}</span>
        <ChevronRight className="ic ic-xs plugin-panel-chev" aria-hidden="true" />
      </button>
      {open ? panel.render() : null}
    </section>
  )
}

/** Panel 扩展点上登记的全部 Panel；没有时不占用空间。 */
export function SidebarPanels() {
  const panels = useContributions("panel")
  const { t } = useLocale()
  if (panels.length === 0) return null
  return (
    <div className="plugin-panels" aria-label={t("plugins.title")}>
      {panels.map((panel) => (
        <SidebarPanel key={panel.id} panel={panel} />
      ))}
    </div>
  )
}
