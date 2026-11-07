/**
 * 和聊天并列的页面：插件与定时任务。页面代码第一次打开时才加载；代码没加载下来或页面出错时
 * 只在内容区显示原因，侧栏照常可用。
 */
import { Suspense, lazy, type ReactNode } from "react"
import { EmptyState, useLocale } from "@pigcode/ui-primitives"
import { PageErrorBoundary, ScrollPanel } from "@pigcode/ui-shell"
import type { CoreDeps } from "./chat-container"

const PluginManagerContainer = lazy(() =>
  import("./plugins-container").then((module) => ({ default: module.PluginManagerContainer })),
)
const SchedulesContainer = lazy(() =>
  import("./schedules").then((module) => ({ default: module.SchedulesContainer })),
)

function PageBoundary({ children }: { children: ReactNode }) {
  const { t } = useLocale()
  return (
    <PageErrorBoundary
      fallback={(reason) => (
        <ScrollPanel>
          <EmptyState title={t("settings.pageError")} description={reason} />
        </ScrollPanel>
      )}
    >
      <Suspense fallback={null}>{children}</Suspense>
    </PageErrorBoundary>
  )
}

export function PluginsView(props: {
  deps: CoreDeps
  onOpenSettings: (page: string) => void
  /** 进入新会话草稿，prefill 拿草稿输入框的键预填内容；还没有项目时返回 false。 */
  onStartDraft: (prefill: (draftKey: string) => void) => boolean
}) {
  return (
    <PageBoundary>
      <PluginManagerContainer {...props} />
    </PageBoundary>
  )
}

export function SchedulesView(props: { deps: CoreDeps; onOpenThread: (threadId: string) => void }) {
  return (
    <PageBoundary>
      <ScrollPanel>
        <SchedulesContainer {...props} />
      </ScrollPanel>
    </PageBoundary>
  )
}
