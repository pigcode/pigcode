/**
 * 聊天主视图：标签栏（主会话与子代理）、消息时间线、输入框与环境抽屉。时间线左侧是会话导航，
 * 右上角浮着状态面板，离开底部时出现圆形的「滚动到底部」按钮。还没有消息时和新会话草稿页一样：
 * 问候、卡片上方带项目的高输入框与建议；会话已经属于这个项目，项目只显示，不能换。历史还没读到时
 * 不知道有没有消息，先按对话的样子摆（输入框在底部），读到了再决定要不要换成问候。
 */
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react"
import type { AgentFeatures, Thread, ThreadEvent } from "@pigcode/contracts"
import { ArrowDown, ArrowLeft, Ellipsis, PanelRight, Waypoints } from "lucide-react"
import {
  type ComposerThreadOption,
  Composer,
  type ComposerAgent,
  type ComposerCommand,
  type ComposerModelCatalog,
  type ComposerModelChoice,
  type ComposerProps,
  type ComposerSubmitOptions,
  type PermissionMode,
} from "@pigcode/ui-composer"
import { Button, formatShortcut, useLocale } from "@pigcode/ui-primitives"
import type { ApprovalDecision } from "./approval-card"
import { EnvironmentDrawer, type EnvironmentInfo } from "./environment-drawer"
import { MessageList } from "./message-list"
import { NewThreadHero, NewThreadStage, NewThreadSuggestions, ProjectChip } from "./new-thread-view"
import { StatusPanel } from "./status-panel"
import type { SubagentCall } from "./subagent-card"
import { SubagentView } from "./subagent-view"
import { ThreadTabs, type ThreadTabsProps } from "./thread-tabs"
import { TurnNavigator } from "./turn-navigator"
import { buildTimeline } from "./turns"
import { latestContextUsage } from "./context-usage"

/** 线程头切换入口需要的 agent 展示信息。 */
export interface AgentOption {
  id: string
  displayName: string
}

/** 还没有消息时代替问候的标题与说明；子代理会话用它说明共用工作目录。 */
export interface EmptyStateText {
  title: string
  hint: string
}

/** ChatView 的公开 props；数据全部由调用方传入，不读取 fixture。 */
export interface ChatViewProps {
  thread?: Thread | null
  events: ThreadEvent[]
  streamingText?: string
  /** 正在输出的思考。 */
  liveReasoning?: string
  /** 当前工作目录（项目根目录）；时间线里的路径按它显示成相对路径。 */
  cwd?: string
  /** 会话所在项目的名字，还没有消息时显示在输入框上方；不提供时取 cwd 的最后一段。 */
  projectName?: string | undefined
  /** 会话的历史还没读到：这时不知道有没有消息，不显示问候，输入框留在底部。 */
  loading?: boolean | undefined
  /** 发送消息；交给 composer 提交，附带本次的思考深度。 */
  onStart?: (text: string, options: ComposerSubmitOptions) => void
  /** 兼容计划接口里的 onSubmit 命名。 */
  onSubmit?: (text: string, options: ComposerSubmitOptions) => void
  onInterrupt?: () => void
  onApproval?: (requestId: string, decision: ApprovalDecision) => void
  /** 当前 agent 的 Agent 功能；未提供时按全部可用处理，保持旧行为。 */
  features?: AgentFeatures | null
  /** 可选的 Agent 实例；输入框的模型选择器按实例分组列出各自的模型。 */
  agents?: readonly ComposerAgent[]
  /** 各实例的模型目录；选择器展开到某个实例时通过 onLoadModels 懒加载。 */
  catalog?: ComposerModelCatalog
  onLoadModels?: (instanceId: string) => void
  /** 切换 Agent 实例与模型；容器应调用 thread.switchAgent。 */
  onSelectModel?: (choice: ComposerModelChoice) => void
  /** 修改线程权限模式；容器应调用 thread.setPermissionMode。 */
  onPermissionMode?: (mode: PermissionMode) => void
  /** @ 引用时可选的项目文件。 */
  files?: () => Promise<readonly string[]>
  /** @ 引用时可选的会话（#81）。 */
  threads?: readonly ComposerThreadOption[]
  /** 输入框里的 / 命令。 */
  commands?: readonly ComposerCommand[]
  /** 读 Agent 实例的 / 命令与 skill；容器应调用 agent.commands（带线程）并缓存。 */
  loadAgentCommands?: ComposerProps["loadAgentCommands"]
  /** 打开时间线里提到的文件（工具行与 @ 引用里的路径，可能是绝对路径）。 */
  onOpenFile?: (path: string) => void
  /** 在右栏查看改动；path 是要看的文件。 */
  onViewDiff?: (path?: string) => void
  /** 右栏是否展开；提供 onToggleRight 且没有 layoutControls 时在线程头显示右栏按钮。 */
  rightOpen?: boolean
  /** 切换右栏；由容器维护展开状态。 */
  onToggleRight?: () => void
  /** 线程头末尾的布局按钮，替代单个右栏按钮；传 null 表示按钮已放在别处（例如右栏标签栏）。 */
  layoutControls?: ReactNode
  /** 线程头右侧「在编辑器中打开项目」的入口；由容器按项目目录组装。 */
  openIn?: ReactNode
  /** 线程头的标签栏：主会话与子代理；不提供时只显示主会话标题。 */
  tabs?: ThreadTabsProps | undefined
  /** 正在查看的派生子代理；有值时显示它的只读过程，不显示输入框。 */
  subagent?: SubagentCall | null | undefined
  /** 在标签页中打开时间线里的派生子代理。 */
  onOpenSubagent?: ((id: string) => void) | undefined
  /** 打开用户 @ 引用的会话。 */
  onOpenThread?: ((threadId: string) => void) | undefined
  /** 从派生子代理的只读视图回到主会话。 */
  onBackToMain?: (() => void) | undefined
  /** 还没有消息时代替问候的文案；子代理会话用它说明共用工作目录。 */
  empty?: EmptyStateText | undefined
  /** 运行中命令已经流出的输出，按工具调用 id。 */
  liveOutput?: Readonly<Record<string, string>> | undefined
  /** 回答 agent 的提问；容器应调用 run.answerQuestion。 */
  onAnswer?: ((requestId: string, answers: string[]) => void) | undefined
}

/** 根据事件流判断当前 run 是否仍在进行。 */
function isRunOpen(events: ThreadEvent[]): boolean {
  let running = false
  for (const event of events) {
    if (event.type === "run.started") running = true
    else if (
      event.type === "run.completed" ||
      event.type === "run.failed" ||
      event.type === "run.interrupted"
    ) {
      running = false
    }
  }
  return running
}

/** 渲染聊天页。 */
export function ChatView({
  thread = null,
  events,
  streamingText = "",
  liveReasoning = "",
  cwd,
  projectName,
  loading = false,
  onStart,
  onSubmit,
  onInterrupt,
  onApproval,
  features = null,
  agents = [],
  catalog = {},
  onLoadModels,
  onSelectModel,
  onPermissionMode,
  files,
  threads,
  commands,
  loadAgentCommands,
  onOpenFile,
  onViewDiff,
  rightOpen = false,
  onToggleRight,
  layoutControls,
  openIn,
  tabs,
  subagent = null,
  onOpenSubagent,
  onOpenThread,
  onBackToMain,
  empty,
  liveOutput,
  onAnswer,
}: ChatViewProps) {
  const submit = onSubmit ?? onStart
  const { t } = useLocale()
  const [drawerOpen, setDrawerOpen] = useState(false)
  const threadRef = useRef<HTMLDivElement>(null)
  const [pinned, setPinned] = useState(true)
  // Agent 功能为 false 时隐藏对应控件；还没读到 Agent 功能时保持旧行为。
  const canInterrupt = features?.streaming ?? true
  const canPlan = features?.plan ?? true
  const canApprove = features?.approvals ?? true
  // 事件数组只在有新事件时变化；流式增量不触发这些整表扫描。
  const visibleEvents = useMemo(
    () =>
      canApprove
        ? events
        : events.filter(
            (event) => event.type !== "approval.requested" && event.type !== "approval.resolved",
          ),
    [events, canApprove],
  )
  const runOpen = useMemo(() => isRunOpen(events), [events])
  const contextUsage = useMemo(() => latestContextUsage(events), [events])
  const running = Boolean(streamingText) || runOpen
  const streaming = streamingText.length > 0
  const timeline = useMemo(
    () => buildTimeline(visibleEvents, streaming),
    [visibleEvents, streaming],
  )
  const instanceId =
    thread?.lastInstanceId ??
    thread?.lastAgentId ??
    thread?.defaultInstanceId ??
    thread?.defaultAgentId ??
    null
  const modelId = thread?.lastModelId ?? null
  /** 按实例 id 找名字；只记得 Agent 时按 Agent 的名字显示。 */
  const agentName = useCallback(
    (id: string) => {
      const exact = agents.find((agent) => agent.id === id)
      if (exact) return exact.label
      return agents.find((agent) => agent.agentId === id)?.label ?? id
    },
    [agents],
  )
  const environment: EnvironmentInfo = {
    // 抽屉显示实例名：默认实例用的是 Agent 的名字，用户新建的实例是自己的名字。
    agent: instanceId ? agentName(instanceId) : t("chat.environment.unknown"),
    cwd,
    modelId,
    permissionMode: thread?.permissionMode ?? "workspace-write",
  }
  const folderName = cwd?.split(/[\\/]/).filter(Boolean).at(-1)
  const viewKey = subagent ? `subagent:${subagent.id}` : (thread?.id ?? null)
  // 确定还没有任何一轮：显示问候与居中的高输入框；时间线里只有切换或近况标记时也算。
  const blank = !subagent && !loading && !timeline.some((entry) => entry.kind === "turn")
  // 问候换成对话时，焦点随着问候里的输入框一起没了，放回底部的输入框。
  const [composerFocus, setComposerFocus] = useState(0)
  const wasBlank = useRef(blank)

  useEffect(() => {
    setPinned(true)
  }, [viewKey])

  useLayoutEffect(() => {
    const focused = document.activeElement
    if (wasBlank.current && !blank && (!focused || focused === document.body)) {
      setComposerFocus((value) => value + 1)
    }
    wasBlank.current = blank
  }, [blank])

  useEffect(() => {
    if (!pinned) return
    const element = threadRef.current
    if (element) element.scrollTop = element.scrollHeight
  }, [events, streamingText, liveReasoning, liveOutput, pinned, subagent])

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

  const mainTitle = thread
    ? folderName
      ? `${folderName} / ${thread.title}`
      : thread.title
    : undefined

  const composerProps = {
    onSubmit: (text: string, options: ComposerSubmitOptions) => submit?.(text, options),
    onStop: onInterrupt ?? (() => undefined),
    running,
    disabled: !thread,
    draftKey: thread?.id ?? null,
    agents,
    agentId: instanceId,
    modelId,
    catalog,
    ...(onLoadModels ? { onLoadModels } : {}),
    ...(thread && onSelectModel ? { onSelectModel } : {}),
    permissionMode: thread?.permissionMode ?? "workspace-write",
    ...(thread && onPermissionMode ? { onPermissionMode } : {}),
    ...(files ? { files } : {}),
    ...(threads ? { threads } : {}),
    ...(commands ? { commands } : {}),
    ...(loadAgentCommands ? { loadAgentCommands } : {}),
    canPlan,
    canInterrupt,
    contextUsage,
  } satisfies ComposerProps
  const shownProject = projectName ?? folderName

  return (
    <section className="view">
      <div className="panel-top">
        {tabs ? (
          <ThreadTabs {...tabs} />
        ) : thread ? (
          <ThreadTabs
            tabs={[{ id: "main", kind: "main", title: thread.title, description: mainTitle }]}
            activeId="main"
            onSelect={() => undefined}
          />
        ) : null}
        <span className="spacer" />
        {thread ? openIn : null}
        <Button
          variant="plain"
          size="icon"
          type="button"
          aria-label={t("chat.environment")}
          title={t("chat.environment")}
          aria-expanded={drawerOpen}
          onClick={() => setDrawerOpen((value) => !value)}
        >
          <Ellipsis className="ic" aria-hidden="true" />
        </Button>
        {layoutControls !== undefined ? (
          layoutControls
        ) : onToggleRight ? (
          <Button
            variant="plain"
            size="icon"
            type="button"
            aria-label={t("panel.toggleRight")}
            title={`${t("panel.toggleRight")} ${formatShortcut("Mod+j")}`}
            aria-pressed={rightOpen}
            onClick={onToggleRight}
          >
            <PanelRight className="ic" aria-hidden="true" />
          </Button>
        ) : null}
      </div>
      {blank ? (
        <NewThreadStage>
          <NewThreadHero title={empty?.title} hint={empty?.hint}>
            {timeline.some((entry) => entry.kind === "brief") ? (
              <p className="new-thread-note" role="note">
                <Waypoints className="ic ic-xs" aria-hidden="true" />
                {t("chat.subagent.brief")}
              </p>
            ) : null}
          </NewThreadHero>
          <Composer
            {...composerProps}
            tall
            {...(shownProject
              ? { header: <ProjectChip name={shownProject} rootPath={cwd} /> }
              : {})}
            autoFocus={Boolean(thread)}
          />
          {thread ? <NewThreadSuggestions draftKey={thread.id} /> : null}
        </NewThreadStage>
      ) : (
        <>
          <div className="thread-wrap">
            <div className="thread" ref={threadRef} onScroll={handleScroll}>
              {subagent ? (
                <SubagentView
                  subagent={subagent}
                  root={cwd}
                  onOpenFile={onOpenFile}
                  onViewDiff={onViewDiff}
                />
              ) : (
                <MessageList
                  events={visibleEvents}
                  timeline={timeline}
                  streamingText={streamingText}
                  liveReasoning={liveReasoning}
                  agentName={agentName}
                  onApproval={onApproval ?? (() => undefined)}
                  root={cwd}
                  onOpenFile={onOpenFile}
                  onViewDiff={onViewDiff}
                  onOpenSubagent={onOpenSubagent}
                  onOpenThread={onOpenThread}
                  liveOutput={liveOutput}
                  onAnswer={onAnswer}
                />
              )}
            </div>
            {subagent ? null : <TurnNavigator timeline={timeline} scroller={threadRef} />}
            {subagent ? null : <StatusPanel timeline={timeline} />}
            {!pinned ? (
              <button
                type="button"
                className="scroll-bottom"
                aria-label={t("chat.scrollToBottom")}
                title={t("chat.scrollToBottom")}
                onClick={jumpToLatest}
              >
                <ArrowDown className="ic ic-sm" aria-hidden="true" />
              </button>
            ) : null}
          </div>
          <div className="composer-wrap">
            {subagent ? (
              <div className="subagent-readonly" role="note">
                <span>{t("chat.subagent.readonly")}</span>
                {onBackToMain ? (
                  <button type="button" className="subagent-back" onClick={onBackToMain}>
                    <ArrowLeft className="ic ic-sm" aria-hidden="true" />
                    {t("chat.subagent.back")}
                  </button>
                ) : null}
              </div>
            ) : (
              <Composer
                {...composerProps}
                focusKey={composerFocus}
                placeholder={t("composer.placeholder.followUp")}
              />
            )}
          </div>
        </>
      )}
      <EnvironmentDrawer
        open={drawerOpen}
        info={environment}
        onClose={() => setDrawerOpen(false)}
      />
    </section>
  )
}
