/** 设置的内容区：画设置页扩展点上的当前页。导航在外壳的侧栏里（SettingsSidebar）。 */
import { Component, type ReactNode } from "react"
import { useContributions, type SettingsPageContribution } from "@pigcode/client-runtime"
import { EmptyState, useLocale } from "@pigcode/ui-primitives"
import { PanelTop } from "./shell"

/** 打开设置时默认的页，也是当前页被移除后退回的页。 */
export const DEFAULT_SETTINGS_PAGE = "general"

/**
 * 要显示的设置页：id 还在就是它；已经移除（例如插件停用）时退回通用页，没有通用页时退回第一页。
 * 一页都没有时原样返回。
 */
export function settingsPageOrFallback(
  pages: readonly SettingsPageContribution[],
  id: string,
): string {
  if (pages.length === 0 || pages.some((page) => page.id === id)) return id
  if (pages.some((page) => page.id === DEFAULT_SETTINGS_PAGE)) return DEFAULT_SETTINGS_PAGE
  return pages[0]?.id ?? id
}

/**
 * 一页（设置页、插件页）出错（代码分块没加载下来、页面组件抛错）时只在内容区显示错误，侧栏和窗口其余部分照常可用。
 * 按页 id 挂载，换一页就重新开始。
 */
export class PageErrorBoundary extends Component<
  { fallback: (reason: string) => ReactNode; children: ReactNode },
  { reason: string | null }
> {
  override state: { reason: string | null } = { reason: null }

  static getDerivedStateFromError(error: unknown): { reason: string } {
    return { reason: error instanceof Error ? error.message : String(error) }
  }

  override render(): ReactNode {
    return this.state.reason === null ? this.props.children : this.props.fallback(this.state.reason)
  }
}

/** 画 id 为 page 的设置页；每一页换进来时重新挂载。顶栏和其他页面一样是窗口拖动区。 */
export function SettingsView({ page }: { page: string }) {
  const { t } = useLocale()
  const current = useContributions("settingsPage").find((item) => item.id === page)
  return (
    <section className="view" aria-label={t("settings.title")}>
      <PanelTop />
      <div className="panel-scroll">
        {current ? (
          <PageErrorBoundary
            key={current.id}
            fallback={(reason) => (
              <EmptyState title={t("settings.pageError")} description={reason} />
            )}
          >
            {current.render()}
          </PageErrorBoundary>
        ) : null}
      </div>
    </section>
  )
}
