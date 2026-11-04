/**
 * 左侧栏的 Panel，以及插件内容的挂载点。Panel 从扩展点注册表读取；插件内容的挂载点由 Panel、
 * Surface、设置页与工具渲染器共用：内容是插件的 React 组件（ADR-0002），在宿主外壳里直接渲染，
 * 能用 useLocale、useTheme 等 hook。渲染出错时不影响宿主：错误显示在内容区。
 */
import { Component, useState, type ComponentType, type ReactNode } from "react"
import { ChevronRight } from "lucide-react"
import { contributionText, useContributions, type PanelContribution } from "@pigcode/client-runtime"
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

/**
 * 挂载一段插件内容。组件在宿主树里直接渲染；外层只负责这个挂载点的宽度、纵向间距与长串换行，
 * 内边距来自侧栏、右栏、设置页各自的容器，卡片和文字样式由插件用 ui-primitives 给出。
 */
export function PluginContentHost({
  id,
  Component: Content,
  kind,
}: {
  id: string
  Component: ComponentType
  kind: "panel" | "surface" | "settings" | "tool"
}) {
  return (
    <div className={`plugin-content plugin-content-${kind}`} data-plugin-content={id}>
      <PluginErrorBoundary
        key={id}
        resetKey={Content}
        fallback={(reason) => (
          <p className="error-text" role="alert">
            {reason}
          </p>
        )}
      >
        <Content />
      </PluginErrorBoundary>
    </div>
  )
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
