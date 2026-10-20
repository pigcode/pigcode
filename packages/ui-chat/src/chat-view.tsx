/** 聊天主视图：标题、运行状态、消息时间线、composer 占位与环境抽屉。 */
import { useState } from "react"
import type { Thread, ThreadEvent } from "@pigcode/contracts"
import { Folder, PanelRight, Square } from "lucide-react"
import { Button, useLocale } from "@pigcode/ui-primitives"
import type { ApprovalDecision } from "./approval-card"
import type { FileChangeSummary } from "./diff-summary"
import { EnvironmentDrawer, type EnvironmentInfo } from "./environment-drawer"
import { MessageList, hasPendingApproval } from "./message-list"
import type { ToolCall } from "./tool-card"

/** ChatView 的公开 props；数据全部由调用方传入，不读取 fixture。 */
export interface ChatViewProps {
  thread?: Thread | null
  events: ThreadEvent[]
  streamingText?: string
  /** 当前工作目录；Task 12 的容器可以传入项目根目录。 */
  cwd?: string
  /** 发送消息；composer 由 Task 9 接入，这里先保留占位。 */
  onStart?: (text: string) => void
  /** 兼容计划接口里的 onSubmit 命名。 */
  onSubmit?: (text: string) => void
  onInterrupt?: () => void
  onApproval?: (requestId: string, decision: ApprovalDecision) => void
  onViewTool?: (tool: ToolCall) => void
  onViewDiff?: (summary: FileChangeSummary) => void
}

/** 根据事件流判断当前 run 是否仍在进行。 */
function isRunOpen(events: ThreadEvent[]): boolean {
  let running = false
  for (const event of events) {
    if (event.type === "run.started") running = true
    else if (event.type === "run.completed" || event.type === "run.failed") running = false
  }
  return running
}

/** 渲染聊天页。 */
export function ChatView({
  thread = null,
  events,
  streamingText = "",
  cwd,
  onInterrupt,
  onApproval,
  onViewTool,
  onViewDiff,
}: ChatViewProps) {
  const { t } = useLocale()
  const [drawerOpen, setDrawerOpen] = useState(false)
  const pendingApproval = hasPendingApproval(events)
  const running = Boolean(streamingText) || isRunOpen(events)
  const status = pendingApproval
    ? t("chat.status.waitingApproval")
    : running
      ? t("chat.status.running")
      : t("chat.status.idle")
  const statusClass = pendingApproval ? "warn" : running ? "ok" : ""
  const environment: EnvironmentInfo = {
    providerId:
      thread?.lastProviderId ?? thread?.defaultProviderId ?? t("chat.environment.unknown"),
    cwd,
    modelId: thread?.lastModelId ?? null,
    permissionMode: thread?.permissionMode ?? "workspace-write",
  }

  return (
    <section className="view">
      <div className="panel-top">
        <div className="title">
          <Folder className="ic muted" aria-hidden="true" />
          <span className="truncate">{thread?.title ?? t("nav.newThread")}</span>
        </div>
        <span className="spacer" />
        <span className={`status ${statusClass}`.trim()}>{status}</span>
        {running ? (
          <Button
            variant="plain"
            size="icon"
            type="button"
            aria-label={t("chat.interrupt")}
            onClick={onInterrupt}
          >
            <Square className="ic" aria-hidden="true" />
          </Button>
        ) : null}
        <Button
          variant="plain"
          size="icon"
          type="button"
          aria-label={t("chat.environment")}
          aria-expanded={drawerOpen}
          onClick={() => setDrawerOpen((value) => !value)}
        >
          <PanelRight className="ic" aria-hidden="true" />
        </Button>
      </div>
      <div className="thread">
        <MessageList
          events={events}
          streamingText={streamingText}
          onApproval={onApproval ?? (() => undefined)}
          onViewTool={onViewTool}
          onViewDiff={onViewDiff}
        />
      </div>
      <div className="composer-wrap">
        <div className="composer-placeholder" role="note">
          {t("chat.composerPlaceholder")}
        </div>
      </div>
      <EnvironmentDrawer
        open={drawerOpen}
        info={environment}
        onClose={() => setDrawerOpen(false)}
      />
    </section>
  )
}
