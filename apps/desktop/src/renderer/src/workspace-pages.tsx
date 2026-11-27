/**
 * 和聊天并列的页面：插件与定时任务。页面代码第一次打开时才加载；代码没加载下来或页面出错时
 * 只在内容区显示原因，侧栏照常可用。
 */
import { Suspense, lazy, type ReactNode } from "react"
import type { HostPool } from "@pigcode/client-runtime"
import { EmptyState, useLocale } from "@pigcode/ui-primitives"
import { PageErrorBoundary, ScrollPanel } from "@pigcode/ui-shell"
import type { CoreDeps } from "./chat-container"

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

export function SchedulesView(props: {
  deps: CoreDeps
  hostPool?: HostPool | undefined
  preferredHostId?: string | undefined
  onOpenThread: (threadId: string, hostId?: string) => void
}) {
  return (
    <PageBoundary>
      <ScrollPanel>
        <SchedulesContainer {...props} />
      </ScrollPanel>
    </PageBoundary>
  )
}
