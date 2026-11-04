/**
 * 左侧栏的 Panel，以及插件内容的挂载点。Panel 从扩展点注册表读取；插件内容的挂载点由 Panel、
 * Surface、设置页与工具渲染器共用：容器带 pg-root，插件的内容使用宿主的字体、颜色与 pg-* 组件样式；
 * 重画或移除前调用插件返回的清理函数。渲染或清理出错时不影响宿主：渲染的错误显示在内容区，清理的错误写进控制台。
 *
 * 插件内容有两种写法（ADR-0002）：
 * - `Component`：插件用宿主的 React 写组件，在宿主外壳里直接渲染，能用 useLocale、useTheme 等 hook；
 * - `render`：DOM 渲染函数，保留给已有的插件，拿到容器自己往里填。
 */
import { Component, useEffect, useRef, useState, type ComponentType, type ReactNode } from "react"
import { ChevronRight } from "lucide-react"
import { contributionText, useContributions, type PanelContribution } from "@pigcode/client-runtime"
import type { ClientRender } from "@pigcode/plugin-sdk"
import { useLocale } from "@pigcode/ui-primitives"

/**
 * 插件组件抛错时只在内容区显示原因，不把整棵树卸掉：时间线、侧栏和窗口其余部分照常可用。
 * 插件换版本（resetKey 变了）后清掉上一版的错误，让新组件重新渲染。
 */
class PluginErrorBoundary extends Component<
  { resetKey: unknown; fallback: (reason: string) => ReactNode; children: ReactNode },
  { reason: string | null }
> {
  override state: { reason: string | null } = { reason: null }

  static getDerivedStateFromError(error: unknown): { reason: string } {
    return { reason: error instanceof Error ? error.message : String(error) }
  }

  override componentDidUpdate(previous: { resetKey: unknown }): void {
    if (previous.resetKey !== this.props.resetKey && this.state.reason !== null) {
      this.setState({ reason: null })
    }
  }

  override render(): ReactNode {
    return this.state.reason === null ? this.props.children : this.props.fallback(this.state.reason)
  }
}

/** 一段插件内容：组件或 DOM 渲染函数，二选一。 */
export interface PluginContent {
  Component?: ComponentType
  render?: ClientRender
}

/**
 * 挂载一段插件内容；kind 区分侧栏面板、右栏标签、设置页与时间线工具行的排版。
 * 组件直接渲染在宿主树里；DOM 渲染函数挂到一个 div 上，render 换了就重画。
 */
export function PluginContentHost({
  id,
  render,
  Component,
  kind,
}: PluginContent & { id: string; kind: "panel" | "surface" | "settings" | "tool" }) {
  if (Component) {
    return (
      <div className={`pg-root pg-${kind}`} data-plugin-content={id}>
        <PluginErrorBoundary
          key={id}
          resetKey={Component}
          fallback={(reason) => (
            <p className="pg-error" role="alert">
              {reason}
            </p>
          )}
        >
          <Component />
        </PluginErrorBoundary>
      </div>
    )
  }
  // checkContribution 保证二选一，这里 render 一定有值。
  return <PluginDomContent id={id} render={render as ClientRender} kind={kind} />
}

/** DOM 渲染函数：插件拿到容器自己往里填，重画或移除前调用它返回的清理函数。 */
function PluginDomContent({
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
  }, [render, id])
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
