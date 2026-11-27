/** 应用外壳：把 store/connection 接到 Shell、聊天、设置与插件管理器。 */
import { useCallback, useEffect, useMemo, useState } from "react"
import { HOST_LOCAL_ID, type HostBrowseDirsResult } from "@pigcode/contracts"
import { HostPool, useAppStore, useContributions, useHostPool } from "@pigcode/client-runtime"
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
import { PanelLayoutControls, updateSurface } from "@pigcode/ui-workbench"
import { AppTerminalSlot, AppWorkbenchSlot } from "./app-slot-panels"
import { useInstanceAgents } from "./agents"
import { BrowserHost } from "./browser-host"
import { AppearanceContext } from "./builtin-settings-pages"
import { ChatViewContainer, type CoreDeps } from "./chat-container"
import { ConnectionBanner } from "./connection-banner"
import { useDesktopReminderNavigation } from "./desktop-reminder-navigation"
import { UnsavedGuard } from "./unsaved-guard"
import { NEW_THREAD_DRAFT_KEY, draftProjectId } from "./new-thread-draft"
import { AddRemoteHostDialog } from "./remote-hosts-page"
import { SettingsHostScopeContext } from "./settings-host-scope"
import { SchedulesView } from "./workspace-pages"
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
import { useAppPanels } from "./use-app-panels"
import { buildHostWorkspaceHandlers, useMultiHostWorkspace } from "./use-multi-host-workspace"
import { workspaceRevision } from "./workspace-revision"
import { UpdateCenterContext, useUpdateCenterState } from "./update-center"
import { useThreadReading } from "./thread-reading"
import { useWorkspaceSync } from "./workspace-sync"

/** App 的依赖。 */
export interface AppProps extends CoreDeps {
  locale: Locale
  hostPool?: HostPool | undefined
}

/** 把 unknown 错误转成可展示文本。 */
function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export function App({ store, connection, plugins, locale, hostPool: providedHostPool }: AppProps) {
  const fallbackPool = useMemo(
    () => new HostPool({ localConnection: connection, localStore: store }),
    [connection, store],
  )
  const pool = providedHostPool ?? fallbackPool
  const poolSnap = useHostPool(pool)
  const [activeHostId, setActiveHostId] = useState<string>(HOST_LOCAL_ID)
  const activeSlot = pool.slot(activeHostId)
  const activeConnection = activeSlot.connection
  const activeStore = activeSlot.store
  const activeHost = poolSnap.hosts.find((h) => h.id === activeSlot.id) ?? poolSnap.hosts[0]

  const localState = useAppStore(store)
  const state = useAppStore(activeStore)
  const appearance = useAppearance()
  const surfaceContributions = useContributions("surface")
  const settingsPages = useContributions("settingsPage")
  const localInstanceAgents = useInstanceAgents(
    connection,
    localState.agentRevision,
    localState.status === "connected",
  )
  const instanceAgents = useInstanceAgents(
    activeConnection,
    state.agentRevision,
    state.status === "connected",
  )
  const agentNames = instanceAgents.names
  const updates = useUpdateCenterState(
    connection,
    store,
    localState.status,
    localInstanceAgents.names,
  )
  const [view, setView] = useState<ShellView>("chat")
  const [selectedPage, setSelectedPage] = useState<string>(DEFAULT_SETTINGS_PAGE)
  const [settingsHostId, setSettingsHostId] = useState<string>(HOST_LOCAL_ID)
  const [addHostOpen, setAddHostOpen] = useState(false)
  const resolvedSettingsHostId = pool.hasSlot(settingsHostId) ? settingsHostId : HOST_LOCAL_ID
  // 选中的设置页被移除（插件停用或卸载）时退回通用页，内容区不留空白。
  const settingsPage = settingsPageOrFallback(settingsPages, selectedPage)
  const activeThreadId = state.activeThreadId
  // 草稿里也能打开右栏和底部终端（参照 ZCode）：它们挂在草稿的项目上，不建会话；
  // 第一次发送建好会话后原样交给它。草稿各自记着右栏、终端开没开，新草稿默认收起。
  // 插槽不随设置、定时任务页变：离开聊天时右栏和终端只是收起，回来时不重新挂载。
  const draftProject = !state.activeThreadId ? draftProjectId(state) : null
  const inChat = view === "chat"
  const [history, setHistory] = useState<NavHistory>(EMPTY_HISTORY)
  // 每次进入新会话草稿递增，草稿页据此把光标放回输入框。
  const [draftFocus, setDraftFocus] = useState(0)
  const [checkoutRevision, setCheckoutRevision] = useState(0)
  const onCheckoutChanged = useCallback(() => setCheckoutRevision((revision) => revision + 1), [])

  const { sidebarProjects, sidebarThreads, hostOfProject, hostOfThread, threadStatus } =
    useMultiHostWorkspace(pool, poolSnap)

  /**
   * 进入新会话草稿（参照 ZCode / Orca）：可指定项目或目标主机；没指定时按默认主机策略回落。
   */
  function startDraft(projectId?: string, explicitHostId?: string): void {
    const inferredHostId =
      explicitHostId ??
      (projectId ? hostOfProject[projectId]?.id : undefined) ??
      pool.resolveTargetHostId(activeSlot.id)
    const targetSlot = pool.slot(inferredHostId)
    if (targetSlot.id !== activeSlot.id) setActiveHostId(targetSlot.id)
    const snapshot = targetSlot.store.getSnapshot()
    const current = snapshot.threads.find((thread) => thread.id === snapshot.activeThreadId)
    const targetProject = projectId ?? current?.projectId ?? snapshot.activeProjectId
    if (targetProject !== snapshot.activeProjectId) {
      targetSlot.store.update({ activeProjectId: targetProject })
    }
    targetSlot.store.setActiveThread(null)
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
    connection: activeConnection,
    connected: state.status === "connected",
    connectionRevision: state.connectionRevision,
    view,
    activeThreadId,
    draftProject,
    threads: state.threads,
    surfaceIds,
    locale,
    onStartDraft: (projectId) => startDraft(projectId),
  })

  // 只在用户正看着设置时把退回的页记下来：不在设置里时页面暂时不在（插件重新加载、停用后又启用），
  // 选中的仍是原来的页，它回来后再打开设置还是它。
  useEffect(() => {
    if (view === "settings" && settingsPage !== selectedPage) setSelectedPage(settingsPage)
  }, [view, settingsPage, selectedPage])

  // 每次落到新的位置都记一笔；从历史里跳转时当前位置已经对上，不会重复记录。
  useEffect(() => {
    const location: NavLocation | null =
      view === "schedules"
        ? { kind: "schedules" }
        : view === "settings"
          ? { kind: "settings", page: settingsPage }
          : state.activeThreadId
            ? { kind: "thread", threadId: state.activeThreadId, hostId: activeSlot.id }
            : null
    if (location) setHistory((current) => pushLocation(current, location))
  }, [view, settingsPage, state.activeThreadId, activeSlot.id])

  const reportWorkspaceError = useCallback(
    (error: unknown) => {
      activeStore.update({ error: messageOf(error) })
    },
    [activeStore],
  )
  // 连上或重连 Host 时合并项目和会话，补齐重启恢复的中断状态与连接中断时创建的定时任务会话（#84）。
  useWorkspaceSync(activeConnection, activeStore, reportWorkspaceError)

  // 当前线程或它的 agent 变化时刷新 Agent 功能，界面据此隐藏不支持的控件。
  // 只依赖 agent id：线程标题、更新时间这类变化不需要重新查询。
  const activeThread = state.threads.find((item) => item.id === state.activeThreadId)
  const activeAgentId = activeThread
    ? (activeThread.lastAgentId ?? activeThread.defaultAgentId)
    : null
  useEffect(() => {
    if (state.status !== "connected" || !activeAgentId) return
    const thread = activeStore
      .getSnapshot()
      .threads.find((item) => item.id === state.activeThreadId)
    if (!thread) return
    void loadAgentFeatures(activeConnection, activeStore, thread).catch((error: unknown) =>
      activeStore.update({ error: messageOf(error) }),
    )
  }, [state.status, state.activeThreadId, activeAgentId, activeConnection, activeStore])

  const activeTimeline = activeThreadId ? state.threadStates[activeThreadId] : undefined
  useThreadReading(activeConnection, {
    threadId: inChat && !(rightOpen && rightMaximized) ? activeThreadId : null,
    connected: state.status === "connected",
    unread: activeThread?.unread,
    target: activeThread?.readTarget,
    manualUnread: activeThread?.manualUnread,
    timeline: activeTimeline,
  })

  function openThread(threadId: string, explicitHostId?: string): void {
    const ownerHostId = explicitHostId ?? hostOfThread[threadId]?.id ?? activeSlot.id
    const targetSlot = pool.slot(ownerHostId)
    if (targetSlot.id !== activeSlot.id) setActiveHostId(targetSlot.id)
    const projectId = targetSlot.store
      .getSnapshot()
      .threads.find((item) => item.id === threadId)?.projectId
    if (projectId) targetSlot.store.update({ activeProjectId: projectId })
    targetSlot.store.openThread(threadId)
    targetSlot.store.setActiveThread(threadId)
    setView("chat")
    if (targetSlot.store.getSnapshot().status === "connected") {
      void targetSlot.connection
        .openThread(threadId)
        .catch((error: unknown) => targetSlot.store.update({ error: messageOf(error) }))
    }
  }

  useDesktopReminderNavigation(
    { connection, store },
    localState.status === "connected",
    (threadId) => openThread(threadId, HOST_LOCAL_ID),
    () => store.update({ error: translate(locale, "reminder.threadUnavailable") }),
  )

  /** 沿历史后退或前进；先去掉已经不存在的会话和已经移除的设置页。 */
  function travel(direction: "back" | "forward"): void {
    const liveKeys = new Set<string>()
    for (const h of poolSnap.hosts) {
      for (const th of pool.slot(h.id).store.getSnapshot().threads) {
        if (th.archivedAt === null) liveKeys.add(`${h.id}:${th.id}`)
      }
    }
    const pages = new Set(settingsPages.map((page) => page.id))
    const pruned = pruneHistory(history, (location) =>
      location.kind === "thread"
        ? liveKeys.has(`${location.hostId ?? HOST_LOCAL_ID}:${location.threadId}`)
        : location.kind !== "settings" || pages.has(location.page),
    )
    const next = direction === "back" ? goBack(pruned) : goForward(pruned)
    setHistory(next)
    const target = currentLocation(next)
    if (!target || next === pruned) return
    if (target.kind === "thread") openThread(target.threadId, target.hostId)
    else if (target.kind === "settings") {
      setSelectedPage(target.page)
      setView("settings")
    } else setView(target.kind)
  }

  const activeProjectName =
    state.projects.find((project) => project.id === (activeThread?.projectId ?? draftProject))
      ?.name ?? ""
  const activeEvents = activeTimeline?.events
  const activeRevision = useMemo(() => workspaceRevision(activeEvents ?? []), [activeEvents])

  const routeNextThread = (ownerId: string, nextThreadId: string | null) => {
    if (nextThreadId) openThread(nextThreadId, ownerId)
  }
  const onSlotError = (targetStore: typeof activeStore) => (error: unknown) =>
    targetStore.update({ error: messageOf(error) })

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
    <SettingsHostScopeContext.Provider
      value={{
        hostPool: pool,
        targetHostId: resolvedSettingsHostId,
        setTargetHostId: setSettingsHostId,
        onOpenSettingsPage: (page) => {
          setSelectedPage(page)
          setView("settings")
        },
        onStartDraftOnHost: (hostId, prefill) => {
          if (pool.slot(hostId).store.getSnapshot().projects.length === 0) return false
          startDraft(undefined, hostId)
          prefill(NEW_THREAD_DRAFT_KEY)
          return true
        },
        onOpenAddHost: () => setAddHostOpen(true),
      }}
    >
      <AppRenderer
        locale={locale}
        updates={updates.indicator}
        view={view}
        projects={sidebarProjects}
        threads={sidebarThreads}
        activeThreadId={state.activeThreadId}
        hosts={poolSnap.hosts}
        activeHostId={activeSlot.id}
        settingsHostId={resolvedSettingsHostId}
        onSelectSettingsHost={setSettingsHostId}
        hostOfProject={hostOfProject}
        hostOfThread={hostOfThread}
        browseRemoteDirs={(hostId, path) =>
          pool
            .slot(hostId)
            .connection.call(
              "host.browseDirs",
              path ? { path } : {},
            ) as Promise<HostBrowseDirsResult>
        }
        onOpenHostsSettings={() => {
          setSelectedPage("remote-hosts")
          setView("settings")
        }}
        onOpenAddHost={() => setAddHostOpen(true)}
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
        onNewThread={(projectId) => startDraft(projectId)}
        onBrowseFiles={(projectId) => {
          const ownerId = hostOfProject[projectId]?.id ?? activeSlot.id
          if (ownerId !== activeSlot.id) setActiveHostId(ownerId)
          browseProjectFiles(projectId)
        }}
        onOpenThread={(threadId) => openThread(threadId)}
        {...buildHostWorkspaceHandlers({
          pool,
          hosts: poolSnap.hosts,
          activeSlot,
          hostOfProject,
          hostOfThread,
          onSelectHost: setActiveHostId,
          onSlotError,
          routeNextThread,
        })}
        onReferenceThread={(thread) => {
          setView("chat")
          requestComposerThreadMention(thread.id, thread.title)
        }}
        rightOpen={rightOpen && inChat}
        rightMaximized={rightMaximized}
        rightPanel={AppWorkbenchSlot({
          activeHostId: activeSlot.id,
          activeConnection,
          activeHost,
          showHostBadge: poolSnap.hosts.length >= 2,
          slotScope: slot.scope,
          slotKey: slot.key,
          panel: slot.key ? panels[slot.key] : undefined,
          rightStarted,
          rightOpen,
          controls: layoutControls(true),
          projectName: activeProjectName,
          workspaceRevision: activeRevision,
          checkoutRevision,
          onPanelChange: (key, update) => updatePanel(key, update),
          onError: (message) => activeStore.update({ error: message }),
          onCheckoutChanged,
        })}
        bottomPanel={AppTerminalSlot({
          activeHostId: activeSlot.id,
          activeConnection,
          slotScope: slot.scope,
          slotKey: slot.key,
          terminalStarted,
          terminalOpen,
          inChat,
          terminalRecovery,
          onClose: () => setTerminalOpen(false),
        })}
      >
        <ConnectionBanner
          store={activeStore}
          activeHost={activeHost}
          onReconnectHost={(hostId) => void window.pigcodeNative?.hosts?.reconnect(hostId)}
        />
        <UnsavedGuard />
        <BrowserHost
          browsers={browsers}
          onPage={(browser, patch) =>
            updatePanel(browser.slotKey, (panel) => updateSurface(panel, browser.id, patch))
          }
        />
        {/* 聊天页一直挂着：去设置、定时任务页时只隐藏，回来不必重画整条时间线、重新拉取 Agent
          与模型列表，滚动位置也还在。 */}
        <div className="chat-keep" data-hidden={inChat ? undefined : ""} inert={!inChat}>
          <ChatViewContainer
            deps={{ connection: activeConnection, store: activeStore, plugins }}
            hosts={poolSnap.hosts}
            activeHost={activeHost}
            onSelectHost={(hostId) => startDraft(undefined, hostId)}
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
        {inChat ? null : view === "schedules" ? (
          <SchedulesView
            deps={{ connection: activeConnection, store: activeStore, plugins }}
            hostPool={pool}
            preferredHostId={activeSlot.id}
            onOpenThread={(threadId, hostId) => openThread(threadId, hostId)}
          />
        ) : (
          <AppearanceContext.Provider value={appearance}>
            <UpdateCenterContext.Provider value={updates}>
              <SettingsView page={settingsPage} />
            </UpdateCenterContext.Provider>
          </AppearanceContext.Provider>
        )}
        <AddRemoteHostDialog
          open={addHostOpen}
          onOpenChange={setAddHostOpen}
          pairingState={poolSnap.pairingState}
        />
      </AppRenderer>
    </SettingsHostScopeContext.Provider>
  )
}
