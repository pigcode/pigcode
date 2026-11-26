/** 应用外壳：把 store/connection 接到 Shell、聊天、设置与插件管理器。 */
import { Suspense, lazy, useCallback, useEffect, useMemo, useState } from "react"
import { useAppStore, useContributions } from "@pigcode/client-runtime"
import { translate, useAppearance, type Locale } from "@pigcode/ui-primitives"
import { requestComposerThreadMention } from "@pigcode/ui-composer"
export type { ChatControls, CoreDeps } from "./chat-container"
import {
  AppRenderer,
  DEFAULT_SETTINGS_PAGE,
  SettingsView,
  settingsPageOrFallback,
  type ShellView,
} from "@pigcode/ui-shell"
import { EMPTY_SURFACE_STATE, PanelLayoutControls, updateSurface } from "@pigcode/ui-workbench"
import { useInstanceAgents } from "./agents"
import { BrowserHost } from "./browser-host"
import { AppearanceContext } from "./builtin-settings-pages"
import { ChatViewContainer, type CoreDeps } from "./chat-container"
import { ConnectionBanner } from "./connection-banner"
import { useDesktopReminderNavigation } from "./desktop-reminder-navigation"
import { UnsavedGuard } from "./unsaved-guard"
import { PluginsView, SchedulesView } from "./workspace-pages"
import {
  EMPTY_HISTORY,
  canGoBack,
  canGoForward,
  currentLocation,
  goBack,
  goForward,
  pruneHistory,
  pushLocation,
  type NavHistory,
  type NavLocation,
} from "./navigation"
import { loadAgentFeatures } from "./agent-context"
import { NEW_THREAD_DRAFT_KEY, draftProjectId } from "./new-thread-draft"
import { useAppPanels } from "./use-app-panels"
import { workspaceRevision } from "./workspace-revision"
import { mergeChildStatus } from "./thread-status"
import { UpdateCenterContext, useUpdateCenterState } from "./update-center"
import { useThreadReading } from "./thread-reading"
import { addProject, sidebarActions } from "./workspace-actions"
import { useWorkspaceSync } from "./workspace-sync"

// 工作台（xterm、diff）与底部终端在第一次打开时才加载，冷启动只加载聊天需要的代码。
const WorkbenchPanel = lazy(() =>
  import("./workbench").then((module) => ({ default: module.WorkbenchPanel })),
)
const TerminalDrawer = lazy(() =>
  import("./terminal-drawer").then((module) => ({ default: module.TerminalDrawer })),
)

/** App 的依赖。 */
export interface AppProps extends CoreDeps {
  locale: Locale
}

/** 把 unknown 错误转成可展示文本。 */
function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export function App({ store, connection, plugins, locale }: AppProps) {
  const state = useAppStore(store)
  const appearance = useAppearance()
  const surfaceContributions = useContributions("surface")
  const settingsPages = useContributions("settingsPage")
  const instanceAgents = useInstanceAgents(
    connection,
    state.agentRevision,
    state.status === "connected",
  )
  const agentNames = instanceAgents.names
  const updates = useUpdateCenterState(connection, store, state.status, agentNames)
  const [view, setView] = useState<ShellView>("chat")
  const [selectedPage, setSelectedPage] = useState<string>(DEFAULT_SETTINGS_PAGE)
  // 选中的设置页被移除（插件停用或卸载）时退回通用页，内容区不留空白。
  const settingsPage = settingsPageOrFallback(settingsPages, selectedPage)
  const activeThreadId = state.activeThreadId
  // 草稿里也能打开右栏和底部终端（参照 ZCode）：它们挂在草稿的项目上，不建会话；
  // 第一次发送建好会话后原样交给它。草稿各自记着右栏、终端开没开，新草稿默认收起。
  // 插槽不随设置、插件、定时任务页变：离开聊天时右栏和终端只是收起，回来时不重新挂载。
  const draftProject = !state.activeThreadId ? draftProjectId(state) : null
  const inChat = view === "chat"
  const [history, setHistory] = useState<NavHistory>(EMPTY_HISTORY)
  // 每次进入新会话草稿递增，草稿页据此把光标放回输入框。
  const [draftFocus, setDraftFocus] = useState(0)
  const [checkoutRevision, setCheckoutRevision] = useState(0)
  const onCheckoutChanged = useCallback(() => setCheckoutRevision((revision) => revision + 1), [])

  /**
   * 进入新会话草稿（参照 ZCode）：不在 Host 上建会话，第一次发送时才建。草稿落在指定的项目里；
   * 没指定时沿用当前会话的项目，再退回最近用过的项目。已经在草稿里时只把光标放回输入框。
   */
  function startDraft(projectId?: string): void {
    const snapshot = store.getSnapshot()
    const current = snapshot.threads.find((thread) => thread.id === snapshot.activeThreadId)
    const target = projectId ?? current?.projectId ?? snapshot.activeProjectId
    if (target !== snapshot.activeProjectId) store.update({ activeProjectId: target })
    store.setActiveThread(null)
    setView("chat")
    setDraftFocus((value) => value + 1)
  }

  const surfaceIds = useMemo(
    () => surfaceContributions.map((surface) => surface.id),
    [surfaceContributions],
  )
  const {
    slot,
    panels,
    rightOpen,
    rightStarted,
    rightMaximized,
    setRightMaximized,
    terminalOpen,
    setTerminalOpen,
    terminalStarted,
    terminalRecovery,
    browsers,
    updatePanel,
    toggleRight,
    toggleTerminal,
    browseProjectFiles,
    openSurface,
    openLinkTab,
  } = useAppPanels({
    connection,
    connected: state.status === "connected",
    connectionRevision: state.connectionRevision,
    view,
    activeThreadId,
    draftProject,
    threads: state.threads,
    surfaceIds,
    locale,
    onStartDraft: startDraft,
  })

  // 只在用户正看着设置时把退回的页记下来：不在设置里时页面暂时不在（插件重新加载、停用后又启用），
  // 选中的仍是原来的页，它回来后再打开设置还是它。
  useEffect(() => {
    if (view === "settings" && settingsPage !== selectedPage) setSelectedPage(settingsPage)
  }, [view, settingsPage, selectedPage])

  // 每次落到新的位置都记一笔；从历史里跳转时当前位置已经对上，不会重复记录。
  useEffect(() => {
    const location: NavLocation | null =
      view === "plugins" || view === "schedules"
        ? { kind: view }
        : view === "settings"
          ? { kind: "settings", page: settingsPage }
          : state.activeThreadId
            ? { kind: "thread", threadId: state.activeThreadId }
            : null
    if (location) setHistory((current) => pushLocation(current, location))
  }, [view, settingsPage, state.activeThreadId])

  const reportWorkspaceError = useCallback(
    (error: unknown) => {
      store.update({ error: messageOf(error) })
    },
    [store],
  )
  // 连上或重连 Host 时合并项目和会话，补齐重启恢复的中断状态与连接中断时创建的定时任务会话（#84）。
  useWorkspaceSync(connection, store, reportWorkspaceError)

  // 当前线程或它的 agent 变化时刷新 Agent 功能，界面据此隐藏不支持的控件。
  // 只依赖 agent id：线程标题、更新时间这类变化不需要重新查询。
  const activeThread = state.threads.find((item) => item.id === state.activeThreadId)
  const activeAgentId = activeThread
    ? (activeThread.lastAgentId ?? activeThread.defaultAgentId)
    : null
  useEffect(() => {
    if (state.status !== "connected" || !activeAgentId) return
    const thread = store.getSnapshot().threads.find((item) => item.id === state.activeThreadId)
    if (!thread) return
    void loadAgentFeatures(connection, store, thread).catch((error: unknown) =>
      store.update({ error: messageOf(error) }),
    )
  }, [state.status, state.activeThreadId, activeAgentId, connection, store])

  const activeTimeline = activeThreadId ? state.threadStates[activeThreadId] : undefined
  useThreadReading(connection, {
    threadId: inChat && !(rightOpen && rightMaximized) ? activeThreadId : null,
    connected: state.status === "connected",
    unread: activeThread?.unread,
    target: activeThread?.readTarget,
    manualUnread: activeThread?.manualUnread,
    timeline: activeTimeline,
  })

  function openThread(threadId: string): void {
    const projectId = store.getSnapshot().threads.find((item) => item.id === threadId)?.projectId
    if (projectId) store.update({ activeProjectId: projectId })
    store.openThread(threadId)
    store.setActiveThread(threadId)
    setView("chat")
    void connection
      .openThread(threadId)
      .catch((error: unknown) => store.update({ error: messageOf(error) }))
  }

  useDesktopReminderNavigation(
    { connection, store },
    state.status === "connected",
    openThread,
    () => store.update({ error: translate(locale, "reminder.threadUnavailable") }),
  )

  /** 沿历史后退或前进；先去掉已经不存在的会话和已经移除的设置页。 */
  function travel(direction: "back" | "forward"): void {
    const live = new Set(
      store
        .getSnapshot()
        .threads.filter((thread) => thread.archivedAt === null)
        .map((thread) => thread.id),
    )
    const pages = new Set(settingsPages.map((page) => page.id))
    const pruned = pruneHistory(history, (location) =>
      location.kind === "thread"
        ? live.has(location.threadId)
        : location.kind !== "settings" || pages.has(location.page),
    )
    const next = direction === "back" ? goBack(pruned) : goForward(pruned)
    setHistory(next)
    const target = currentLocation(next)
    if (!target || next === pruned) return
    if (target.kind === "thread") openThread(target.threadId)
    else if (target.kind === "settings") {
      setSelectedPage(target.page)
      setView("settings")
    } else setView(target.kind)
  }

  // 子代理只在主会话的标签栏里出现；侧栏和命令面板只列主会话。
  const mainThreads = useMemo(
    () => state.threads.filter((thread) => !thread.parentThreadId),
    [state.threads],
  )
  const threadStatus = useMemo(
    () => mergeChildStatus(state.threads, state.threadStates),
    [state.threads, state.threadStates],
  )
  const activeProjectName =
    state.projects.find((project) => project.id === (activeThread?.projectId ?? draftProject))
      ?.name ?? ""
  const activeEvents = activeTimeline?.events
  const activeRevision = useMemo(() => workspaceRevision(activeEvents ?? []), [activeEvents])

  const sidebar = sidebarActions(connection, store, {
    openThread,
    onError: (error) => store.update({ error: messageOf(error) }),
  })

  const layoutControls = (maximizable: boolean) => (
    <PanelLayoutControls
      rightOpen={rightOpen && slot.scope !== null}
      onToggleRight={maximizable || !rightOpen ? toggleRight : undefined}
      terminalOpen={terminalOpen && slot.scope !== null}
      onToggleTerminal={maximizable ? undefined : toggleTerminal}
      {...(maximizable
        ? {
            maximized: rightMaximized,
            onToggleMaximize: () => setRightMaximized((value) => !value),
          }
        : {})}
      disabled={!slot.scope}
    />
  )

  return (
    <AppRenderer
      locale={locale}
      updates={updates.indicator}
      view={view}
      projects={state.projects}
      threads={mainThreads}
      activeThreadId={state.activeThreadId}
      threadStatus={threadStatus}
      agentNames={agentNames}
      onToggleRight={toggleRight}
      onToggleTerminal={toggleTerminal}
      canGoBack={canGoBack(history)}
      canGoForward={canGoForward(history)}
      onBack={() => travel("back")}
      onForward={() => travel("forward")}
      settingsPage={settingsPage}
      onView={setView}
      onSettingsPage={setSelectedPage}
      onAddProject={(path, name) => {
        void addProject(connection, store, path, name).catch((error: unknown) =>
          store.update({ error: messageOf(error) }),
        )
      }}
      onNewThread={startDraft}
      onBrowseFiles={browseProjectFiles}
      onOpenThread={openThread}
      {...sidebar}
      onReferenceThread={(thread) => {
        // 在当前会话（或草稿）的输入框里插入这个会话的引用；在设置等页面时先回到聊天。
        setView("chat")
        requestComposerThreadMention(thread.id, thread.title)
      }}
      rightOpen={rightOpen && inChat}
      rightMaximized={rightMaximized}
      rightPanel={
        slot.scope && slot.key && (rightStarted || rightOpen) ? (
          <Suspense fallback={null}>
            <WorkbenchPanel
              key={slot.key}
              connection={connection}
              scope={slot.scope}
              slotKey={slot.key}
              panel={panels[slot.key] ?? EMPTY_SURFACE_STATE}
              onPanelChange={(update) => {
                if (slot.key) updatePanel(slot.key, update)
              }}
              controls={layoutControls(true)}
              onError={(message) => store.update({ error: message })}
              projectName={activeProjectName}
              workspaceRevision={activeRevision}
              checkoutRevision={checkoutRevision}
              onCheckoutChanged={onCheckoutChanged}
            />
          </Suspense>
        ) : undefined
      }
      bottomPanel={
        slot.scope && slot.key && terminalStarted ? (
          <Suspense fallback={null}>
            <TerminalDrawer
              key={slot.key}
              connection={connection}
              owner={slot.scope}
              open={terminalOpen && inChat}
              onClose={() => setTerminalOpen(false)}
              initialSessions={terminalRecovery.drawerSessionsBySlot[slot.key]}
              recovering={terminalRecovery.recovering}
              onTerminalBound={(id) => {
                if (slot.key) terminalRecovery.registerDrawerTerminal(slot.key, id)
              }}
              onTerminalClosed={(id) => {
                if (slot.key) terminalRecovery.unregisterDrawerTerminal(slot.key, id)
              }}
            />
          </Suspense>
        ) : undefined
      }
    >
      <ConnectionBanner store={store} />
      <UnsavedGuard />
      <BrowserHost
        browsers={browsers}
        onPage={(browser, patch) =>
          updatePanel(browser.slotKey, (panel) => updateSurface(panel, browser.id, patch))
        }
      />
      {/* 聊天页一直挂着：去设置、插件、定时任务页时只隐藏，回来不必重画整条时间线、重新拉取 Agent
          与模型列表，滚动位置也还在。 */}
      <div className="chat-keep" data-hidden={inChat ? undefined : ""} inert={!inChat}>
        <ChatViewContainer
          deps={{ connection, store, plugins }}
          rightOpen={rightOpen}
          onToggleRight={toggleRight}
          layoutControls={layoutControls(false)}
          onOpenFile={(path: string) => openSurface("file", path)}
          onOpenDiff={() => openSurface("diff")}
          onOpenLinkTab={openLinkTab}
          onOpenThread={openThread}
          draftFocus={draftFocus}
          checkoutRevision={checkoutRevision}
          onCheckoutChanged={onCheckoutChanged}
        />
      </div>
      {inChat ? null : view === "plugins" ? (
        <PluginsView
          deps={{ connection, store, plugins }}
          onStartDraft={(prefill) => {
            if (store.getSnapshot().projects.length === 0) return false
            startDraft()
            prefill(NEW_THREAD_DRAFT_KEY)
            return true
          }}
          onOpenSettings={(page) => {
            setSelectedPage(page)
            setView("settings")
          }}
        />
      ) : view === "schedules" ? (
        <SchedulesView deps={{ connection, store, plugins }} onOpenThread={openThread} />
      ) : (
        <AppearanceContext.Provider value={appearance}>
          <UpdateCenterContext.Provider value={updates}>
            <SettingsView page={settingsPage} />
          </UpdateCenterContext.Provider>
        </AppearanceContext.Provider>
      )}
    </AppRenderer>
  )
}
