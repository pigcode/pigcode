/** 聊天主视图：标题、运行状态、消息时间线、composer 占位与环境抽屉。 */
import { useEffect, useRef, useState, type ReactNode } from "react"
import type { ProviderCapabilities, Thread, ThreadEvent } from "@pigcode/contracts"
import { ArrowDown, Check, ChevronDown, Folder, PanelRight, PanelRightOpen, Square } from "lucide-react"
import { Composer } from "@pigcode/ui-composer"
import { Button, Menu, useLocale } from "@pigcode/ui-primitives"
import type { ApprovalDecision } from "./approval-card"
import type { FileChangeSummary } from "./diff-summary"
import { EnvironmentDrawer, type EnvironmentInfo } from "./environment-drawer"
import { MessageList, hasPendingApproval } from "./message-list"
import type { ToolCall } from "./tool-card"

/** 线程头切换入口需要的 provider 展示信息。 */
export interface ProviderOption {
  id: string
  displayName: string
}

/** ChatView 的公开 props；数据全部由调用方传入，不读取 fixture。 */
export interface ChatViewProps {
  thread?: Thread | null
  events: ThreadEvent[]
  streamingText?: string
  /** 当前工作目录；Task 12 的容器可以传入项目根目录。 */
  cwd?: string
  /** 发送消息；交给 composer 提交。 */
  onStart?: (text: string) => void
  /** 兼容计划接口里的 onSubmit 命名。 */
  onSubmit?: (text: string) => void
  onInterrupt?: () => void
  onApproval?: (requestId: string, decision: ApprovalDecision) => void
  /** 当前 provider 的能力；未提供时按全部可用处理，保持旧行为。 */
  capabilities?: ProviderCapabilities | null
  /** 当前 provider 可选的模型 id；为空时不显示模型控件。 */
  models?: readonly string[]
  /** provider 列表；非空时在线程头显示切换入口。 */
  providers?: readonly ProviderOption[]
  /** 切换 provider；容器应调用 thread.switchProvider。 */
  onSwitchProvider?: (providerId: string) => void
  /** 切换模型；容器应调用 thread.switchProvider。 */
  onSwitchModel?: (modelId: string) => void
  onViewTool?: (tool: ToolCall) => void
  onViewDiff?: (summary: FileChangeSummary) => void
  /** 右栏是否展开；提供 onToggleRight 时在线程头显示工作台按钮。 */
  rightOpen?: boolean
  /** 切换右栏；由容器维护展开状态。 */
  onToggleRight?: () => void
  /** 多会话 tab 栏；渲染在面板顶栏上方。 */
  tabs?: ReactNode
}

/** 线程头下拉菜单；provider 与模型切换共用。 */
function HeaderMenu({
  label,
  title,
  items,
  selected,
  onSelect,
}: {
  label: string
  title: string
  items: ReadonlyArray<{ id: string; label: string }>
  selected: string | null
  onSelect: (id: string) => void
}) {
  return (
    <Menu.Root>
      <Menu.Trigger className="chip-btn" type="button" title={title}>
        {label}
        <ChevronDown className="ic chip-caret" aria-hidden="true" />
      </Menu.Trigger>
      <Menu.Portal>
        <Menu.Positioner className="menu-positioner" side="bottom" align="end" sideOffset={6}>
          <Menu.Popup className="menu-popup">
            {items.map((item) => (
              <Menu.Item key={item.id} className="menu-item" onClick={() => onSelect(item.id)}>
                {item.label}
                {item.id === selected ? (
                  <Check className="ic check-mark" aria-hidden="true" />
                ) : null}
              </Menu.Item>
            ))}
          </Menu.Popup>
        </Menu.Positioner>
      </Menu.Portal>
    </Menu.Root>
  )
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
  onStart,
  onSubmit,
  onInterrupt,
  onApproval,
  capabilities = null,
  models = [],
  providers = [],
  onSwitchProvider,
  onSwitchModel,
  onViewTool,
  onViewDiff,
  rightOpen = false,
  onToggleRight,
  tabs,
}: ChatViewProps) {
  const submit = onSubmit ?? onStart
  const { t } = useLocale()
  const [drawerOpen, setDrawerOpen] = useState(false)
  const threadRef = useRef<HTMLDivElement>(null)
  const [pinned, setPinned] = useState(true)
  // capability 为 false 时隐藏对应控件；未加载能力时保持旧行为。
  const canInterrupt = capabilities?.streaming ?? true
  const canPlan = capabilities?.plan ?? true
  const canApprove = capabilities?.approvals ?? true
  const canSelectModel = capabilities?.modelCatalog ?? true
  const visibleEvents = canApprove
    ? events
    : events.filter(
        (event) => event.type !== "approval.requested" && event.type !== "approval.resolved",
      )
  const pendingApproval = hasPendingApproval(visibleEvents)
  const running = Boolean(streamingText) || isRunOpen(events)
  const status = pendingApproval
    ? t("chat.status.waitingApproval")
    : running
      ? t("chat.status.running")
      : t("chat.status.idle")
  const statusClass = pendingApproval ? "warn" : running ? "ok" : ""
  const providerId = thread?.lastProviderId ?? thread?.defaultProviderId ?? null
  const modelId = thread?.lastModelId ?? null
  const providerName =
    providers.find((provider) => provider.id === providerId)?.displayName ??
    providerId ??
    t("chat.environment.provider")
  const environment: EnvironmentInfo = {
    providerId: providerId ?? t("chat.environment.unknown"),
    cwd,
    modelId,
    permissionMode: thread?.permissionMode ?? "workspace-write",
  }
  const assistantInitial =
    providerId === "claude" ? "CL" : providerId === "codex" ? "CX" : providerName.slice(0, 2).toUpperCase()
  const projectName = cwd?.split(/[\\/]/).filter(Boolean).at(-1)

  useEffect(() => {
    setPinned(true)
  }, [thread?.id])

  useEffect(() => {
    if (!pinned) return
    const element = threadRef.current
    if (element) element.scrollTop = element.scrollHeight
  }, [events, streamingText, pinned])

  function handleScroll(): void {
    const element = threadRef.current
    if (!element) return
    setPinned(element.scrollHeight - element.scrollTop - element.clientHeight < 64)
  }

  function jumpToLatest(): void {
    setPinned(true)
    const element = threadRef.current
    element?.scrollTo({ top: element.scrollHeight, behavior: "smooth" })
  }

  return (
    <section className="view">
      {tabs}
      <div className="panel-top">
        <div className="title">
          <Folder className="ic muted" aria-hidden="true" />
          <span className="title-copy">
            <span className="truncate">{thread?.title ?? t("nav.newThread")}</span>
            {projectName ? <small className="truncate">{projectName}</small> : null}
          </span>
        </div>
        <span className="spacer" />
        <span className={`status status-pill ${statusClass}`.trim()}>{status}</span>
        {!running && thread && providers.length > 0 && onSwitchProvider ? (
          <HeaderMenu
            label={providerName}
            title={t("chat.environment.provider")}
            items={providers.map((provider) => ({
              id: provider.id,
              label: provider.displayName,
            }))}
            selected={providerId}
            onSelect={onSwitchProvider}
          />
        ) : null}
        {!running && thread && canSelectModel && models.length > 0 && onSwitchModel ? (
          <HeaderMenu
            label={modelId ?? t("chat.environment.model")}
            title={t("chat.environment.model")}
            items={models.map((id) => ({ id, label: id }))}
            selected={modelId}
            onSelect={onSwitchModel}
          />
        ) : null}
        {running && canInterrupt ? (
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
        {onToggleRight ? (
          <Button
            variant="plain"
            size="icon"
            type="button"
            aria-label={t("workbench.title")}
            aria-pressed={rightOpen}
            onClick={onToggleRight}
          >
            <PanelRightOpen className="ic" aria-hidden="true" />
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
      <div className="thread" ref={threadRef} onScroll={handleScroll}>
        <MessageList
          events={visibleEvents}
          streamingText={streamingText}
          assistantName={providerName}
          assistantInitial={assistantInitial}
          onApproval={onApproval ?? (() => undefined)}
          onViewTool={onViewTool}
          onViewDiff={onViewDiff}
        />
      </div>
      {!pinned ? (
        <button type="button" className="jump-latest" onClick={jumpToLatest}>
          <ArrowDown className="ic ic-sm" aria-hidden="true" />
          {t("chat.jumpLatest")}
        </button>
      ) : null}
      <div className="composer-wrap">
        <Composer
          onSubmit={(text) => submit?.(text)}
          onStop={onInterrupt ?? (() => undefined)}
          running={running}
          disabled={!thread}
          autoFocus={Boolean(thread) && visibleEvents.length === 0 && !running}
          {...(modelId ? { model: modelId } : {})}
          models={canSelectModel ? models : []}
          {...(onSwitchModel ? { onModel: onSwitchModel } : {})}
          canPlan={canPlan}
          canInterrupt={canInterrupt}
        />
      </div>
      <EnvironmentDrawer
        open={drawerOpen}
        info={environment}
        onClose={() => setDrawerOpen(false)}
      />
    </section>
  )
}
