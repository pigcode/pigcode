/**
 * 聊天页容器：从 store 读取线程与事件，把输入框里的操作（发送、切换 agent/模型、权限）交给 Host。
 * 线程头是一组标签：主会话、用户添加的子代理会话、主 agent 派生的子代理；输入框与中断、
 * 审批都作用在当前标签所在的会话上。
 */
import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react"
import { useThreadOptions } from "./thread-options"
import {
  contributionText,
  useAppStore,
  useContributions,
  type AppStore,
  type Connection,
} from "@pigcode/client-runtime"
import { useLocale } from "@pigcode/ui-primitives"
import { ChatView, collectSubagents } from "@pigcode/ui-chat"
import { useAgentCommandsLoader } from "./agent-commands"
import type { ComposerCommand } from "@pigcode/ui-composer"
import type { ClientPluginController } from "./client-plugins"
import { useAgentFeatures, useAgents, useModelCatalog } from "./agents"
import {
  createChatThreadActions,
  messageOf,
  projectRelative,
  useChatAttachmentActions,
  useChatLinkActions,
} from "./chat-helpers"
import { runRequestHandlers } from "./run-request-handlers"
import { QueuedMessages } from "./queued-messages"
import { submitDesktopMessage } from "./desktop-message-recovery"
import { NewThreadPage } from "./new-thread-page"
import { ThreadWorkspaceDetails } from "./thread-workspace-details"
import { useThreadWorkspaceRoot } from "./use-thread-workspace-root"
import { workspaceRevision } from "./workspace-revision"
import {
  buildThreadTabs,
  childThreads,
  openSpawnedTab,
  selectThreadTab,
  useThreadTabState,
  visibleSpawned,
} from "./thread-tabs"

/** 核心容器共享的依赖。 */
export interface CoreDeps {
  connection: Connection
  store: AppStore
  plugins: ClientPluginController
}

/** 聊天容器的右栏控制：线程头的切换按钮、文件与 Diff 标签的打开入口。 */
export interface ChatControls {
  rightOpen?: boolean
  onToggleRight?: () => void
  /** 线程头末尾的布局按钮，排在会话详情的开关后面。 */
  layoutControls?: ReactNode
  /** 在右栏的文件标签里打开项目内的文件（相对路径）。 */
  onOpenFile?: (path: string) => void
  /** 在右栏打开 Diff。 */
  onOpenDiff?: () => void
  /** 在右栏新建一个打开此网址的浏览器标签。 */
  onOpenLinkTab?: (url: string) => void
  /** 打开用户 @ 引用的会话（#81）。 */
  onOpenThread?: (threadId: string) => void
  /** 每次进入新会话草稿都会变；变了就把光标放回草稿的输入框。 */
  draftFocus?: number
  checkoutRevision?: number
  onCheckoutChanged?: () => void
}

/** 聊天页容器。 */
export function ChatViewContainer({
  deps,
  rightOpen = false,
  onToggleRight,
  layoutControls,
  onOpenFile,
  onOpenThread,
  onOpenDiff,
  onOpenLinkTab,
  draftFocus,
  checkoutRevision = 0,
  onCheckoutChanged,
}: { deps: CoreDeps } & ChatControls) {
  const state = useAppStore(deps.store)
  const { t } = useLocale()
  // 输入框的 `/` 和命令面板用同一份 Command：下面只取登记了 slash 的那几条。
  const registeredCommands = useContributions("command")
  const active = state.threads.find((item) => item.id === state.activeThreadId) ?? null
  // 子代理不在侧栏里；从历史或命令面板落到子代理时，按它的主会话显示并选中它的标签。
  const main = active?.parentThreadId
    ? (state.threads.find((item) => item.id === active.parentThreadId) ?? active)
    : active
  const mainId = main?.id ?? null
  const project = state.projects.find((item) => item.id === main?.projectId)
  const workspaceRoot = useThreadWorkspaceRoot(
    deps.connection,
    mainId,
    state.status === "connected",
    checkoutRevision,
  )
  const threadChoices = useThreadOptions(
    state.threads,
    state.projects,
    mainId,
    main?.projectId ?? null,
  )
  const connected = state.status === "connected"
  const configuredAgents = useAgents(deps.connection, state.agentRevision, connected)
  const featuresByAgent = useAgentFeatures(deps.connection, state.agentRevision, connected)
  const { catalog, load, instanceModes } = useModelCatalog(
    deps.connection,
    state.agentRevision,
    connected,
  )
  const agents = useMemo(
    () =>
      configuredAgents.map((agent) => {
        const modes = instanceModes[agent.id]
        return modes ? { ...agent, executionModes: modes } : agent
      }),
    [configuredAgents, instanceModes],
  )
  const [notice, setNotice] = useState<string | null>(null)
  const tabState = useThreadTabState(mainId)
  const children = useMemo(() => childThreads(state.threads, mainId), [state.threads, mainId])
  const childKey = children.map((child) => child.id).join(",")

  useEffect(() => {
    if (!active?.parentThreadId || !mainId) return
    selectThreadTab(mainId, `agent:${active.id}`)
    deps.store.setActiveThread(mainId)
  }, [active, mainId, deps.store])

  // 子代理标签要显示运行状态，主会话打开时把它的子代理也订阅上。
  useEffect(() => {
    if (!connected || !childKey) return
    const open = new Set(deps.store.getSnapshot().openThreadIds)
    for (const childId of childKey.split(",")) {
      if (open.has(childId)) continue
      deps.store.openThread(childId)
      void deps.connection.openThread(childId).catch(() => undefined)
    }
  }, [connected, childKey, deps.store, deps.connection])

  useEffect(() => {
    if (!notice) return undefined
    const timer = setTimeout(() => setNotice(null), 4000)
    return () => clearTimeout(timer)
  }, [notice])

  const fail = useCallback(
    (error: unknown) => deps.store.update({ error: messageOf(error) }),
    [deps.store],
  )
  const linkActions = useChatLinkActions({ onOpenLinkTab, fail, t })

  const mainEvents = mainId ? (state.threadStates[mainId]?.events ?? state.events) : state.events
  // 子代理共用主会话的工作目录，详情卡里的 git 状态跟着主会话的改动重读。
  const detailsRevision = useMemo(() => workspaceRevision(mainEvents), [mainEvents])
  const subagents = useMemo(() => collectSubagents(mainEvents), [mainEvents])
  const spawned = visibleSpawned(subagents, tabState)
  const selected = tabState.selected
  const viewChild = selected.startsWith("agent:")
    ? children.find((child) => `agent:${child.id}` === selected)
    : undefined
  const viewSubagent = selected.startsWith("spawned:")
    ? spawned.find((subagent) => `spawned:${subagent.id}` === selected)
    : undefined
  const thread = viewChild ?? main
  const threadId = thread?.id ?? null
  const viewState = threadId ? state.threadStates[threadId] : undefined
  const events = viewChild ? (viewState?.events ?? []) : mainEvents
  const streamingText = viewChild
    ? (viewState?.streamingText ?? "")
    : mainId
      ? (state.threadStates[mainId]?.streamingText ?? state.streamingText)
      : state.streamingText
  const liveOutput = viewChild
    ? viewState?.liveOutput
    : mainId
      ? state.threadStates[mainId]?.liveOutput
      : undefined
  const liveReasoning = viewChild
    ? (viewState?.liveReasoning ?? "")
    : mainId
      ? (state.threadStates[mainId]?.liveReasoning ?? "")
      : ""
  // Agent 功能按 driver 记；实例 id 与 driver id 相同时直接命中，否则按实例找到它的 driver。
  const viewInstanceId =
    thread?.lastInstanceId ??
    thread?.lastAgentId ??
    thread?.defaultInstanceId ??
    thread?.defaultAgentId ??
    null
  const viewAgentId =
    agents.find((agent) => agent.id === viewInstanceId)?.agentId ??
    thread?.lastAgentId ??
    thread?.defaultAgentId ??
    null
  const features = (viewAgentId ? featuresByAgent[viewAgentId] : undefined) ?? state.agentFeatures

  const statuses = useMemo(
    () =>
      Object.fromEntries(
        Object.entries(state.threadStates).map(([id, value]) => [id, value.status]),
      ),
    [state.threadStates],
  )
  const tabs = main
    ? buildThreadTabs({ main, projectName: project?.name, children, statuses, spawned })
    : []
  const activeTabId = tabs.some((tab) => tab.id === selected) ? selected : "main"

  /** 当前会话最近一条带 runId 的事件所属的 run；中断与审批都作用在它上面。 */
  function latestRunId(): string | null {
    return [...events].reverse().find((event) => event.runId !== null)?.runId ?? null
  }

  function interrupt(): void {
    const runId = latestRunId()
    if (!runId || !threadId) return
    void deps.connection.call("run.interrupt", { threadId, runId }).catch(fail)
  }

  const { respondApproval, answerQuestion } = runRequestHandlers({
    connection: deps.connection,
    threadId,
    latestRunId,
    t,
    setNotice,
    fail,
  })

  const { selectModel, setPermissionMode, setPlanMode, closeTab } = createChatThreadActions({
    connection: deps.connection,
    store: deps.store,
    thread,
    mainId,
    selectedTab: selected,
    agents,
    t,
    setNotice,
    fail,
  })

  const fileRoot = mainId
  const loadAgentCommands = useAgentCommandsLoader(deps.connection, threadId ? { threadId } : null)
  const files = useMemo(
    () =>
      fileRoot
        ? async () => {
            const entries = (await deps.connection.call("workspace.tree", {
              threadId: fileRoot,
            })) as Array<{ path: string }>
            return entries.map((entry) => entry.path)
          }
        : undefined,
    [deps.connection, fileRoot],
  )

  const commands = useMemo<ComposerCommand[]>(
    () =>
      registeredCommands
        .filter((command) => command.slash !== undefined)
        .map((command) => ({
          // 加前缀：不和输入框自己的命令（model、permission-*）撞 id。
          id: `command-${command.id}`,
          label: `/${command.slash}`,
          description: contributionText(t, command.title),
          ...(command.keywords ? { keywords: command.keywords } : {}),
          // `/` 建议更新时才判断，不在这里缓存结果。
          available: command.available,
          run: () => void command.run(),
        })),
    [registeredCommands, t],
  )

  const { uploadImage, readAttachment, peekAttachment } = useChatAttachmentActions(
    deps.connection,
    threadId,
  )

  // 没有当前会话就是新会话草稿：发第一条消息时才建会话。
  if (!main) {
    return (
      <NewThreadPage
        deps={deps}
        agents={agents}
        catalog={catalog}
        onLoadModels={load}
        featuresByAgent={featuresByAgent}
        commands={commands}
        focusKey={draftFocus}
        layoutControls={layoutControls}
        onBranchChanged={onCheckoutChanged}
        onOpenDiff={onOpenDiff}
        checkoutRevision={checkoutRevision}
      />
    )
  }

  return (
    <>
      {notice ? (
        <div className="toast-stack" role="status" aria-live="polite">
          <div className="toast">{notice}</div>
        </div>
      ) : null}
      <ChatView
        thread={thread}
        events={events}
        streamingText={streamingText}
        liveReasoning={liveReasoning}
        liveOutput={liveOutput}
        features={features}
        agents={agents}
        catalog={catalog}
        onLoadModels={load}
        {...(project ? { projectName: project.name } : {})}
        {...(workspaceRoot ? { cwd: workspaceRoot } : {})}
        loading={threadId !== null && !state.threadStates[threadId]?.loaded}
        onStart={(text, options) => {
          if (!threadId) return
          void submitDesktopMessage(deps.connection, threadId, text, options, fail)
        }}
        onInterrupt={interrupt}
        onApproval={respondApproval}
        onAnswer={answerQuestion}
        queuePanel={
          threadId && !viewChild ? (
            <QueuedMessages
              connection={deps.connection}
              threadId={threadId}
              events={events}
              connected={connected}
              fail={fail}
            />
          ) : undefined
        }
        {...(onOpenFile
          ? {
              onOpenFile: (target: string) => {
                const path = projectRelative(target, workspaceRoot)
                if (path) onOpenFile(path)
              },
            }
          : {})}
        {...(onOpenDiff ? { onViewDiff: () => onOpenDiff() } : {})}
        linkActions={linkActions}
        onSelectModel={selectModel}
        onPermissionMode={setPermissionMode}
        onPlanMode={setPlanMode}
        {...(files ? { files } : {})}
        threads={threadChoices}
        {...(onOpenThread ? { onOpenThread } : {})}
        commands={commands}
        loadAgentCommands={loadAgentCommands}
        onUploadImage={uploadImage}
        readAttachment={readAttachment}
        peekAttachment={peekAttachment}
        rightOpen={rightOpen}
        {...(onToggleRight ? { onToggleRight } : {})}
        {...(layoutControls !== undefined ? { layoutControls } : {})}
        {...(workspaceRoot && mainId
          ? {
              details: (
                <ThreadWorkspaceDetails
                  connection={deps.connection}
                  threadId={mainId}
                  root={workspaceRoot}
                  projectRoot={project?.rootPath}
                  revision={detailsRevision + checkoutRevision}
                  onOpenDiff={onOpenDiff}
                />
              ),
            }
          : {})}
        {...(main
          ? {
              tabs: {
                tabs,
                activeId: activeTabId,
                onSelect: (tabId: string) => selectThreadTab(main.id, tabId),
                onClose: closeTab,
                agents,
              },
              onOpenSubagent: (subagentId: string) => openSpawnedTab(main.id, subagentId),
              onBackToMain: () => selectThreadTab(main.id, "main"),
            }
          : {})}
        subagent={viewSubagent ?? null}
        {...(viewChild
          ? { empty: { title: t("chat.subagent.emptyTitle"), hint: t("chat.subagent.emptyHint") } }
          : {})}
      />
    </>
  )
}
