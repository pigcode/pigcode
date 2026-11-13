/** 应用外壳：把 store/connection 接到 Shell、聊天、设置与插件管理器。 */
import { Suspense, lazy, useCallback, useEffect, useMemo, useRef, useState } from "react"
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
import {
  EMPTY_SURFACE_STATE,
  PanelLayoutControls,
  addSurface,
  closeRemovedSurfaces,
  openFileSurface,
  updateSurface,
  type PanelSurfaceState,
} from "@pigcode/ui-workbench"
import { useInstanceAgents } from "./agents"
import { BrowserHost } from "./browser-host"
import { AppearanceContext } from "./builtin-settings-pages"
import { ChatViewContainer, type CoreDeps } from "./chat-container"
import { ConnectionBanner } from "./connection-banner"
import { UnsavedGuard } from "./unsaved-guard"
import { PluginsView, SchedulesView } from "./workspace-pages"
import { useBrowserOpen } from "./use-browser-open"
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
import { usePanelOpen } from "./use-panel-open"
import { useWorkspaceSlot } from "./use-workspace-slot"
import { workspaceRevision } from "./workspace-revision"
import { mergeChildStatus } from "./thread-status"
import { UpdateCenterContext, useUpdateCenterState } from "./update-center"

// 工作台（xterm、diff）与底部终端在第一次打开时才加载，冷启动只加载聊天需要的代码。
const WorkbenchPanel = lazy(() =>
  import("./workbench").then((module) => ({ default: module.WorkbenchPanel })),
)
const TerminalDrawer = lazy(() =>
  import("./terminal-drawer").then((module) => ({ default: module.TerminalDrawer })),
)
import {
  addProject,
  archiveThread,
  loadWorkspace,
  removeProject,
  renameProject,
  renameThread,
} from "./workspace-actions"

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
  // 右栏第一次打开后才挂载（按需加载工作台代码），之后收起只隐藏，终端与浏览器标签保留。
  const [rightStarted, setRightStarted] = useState(false)
  const [rightMaximized, setRightMaximized] = useState(false)
  // 底部终端第一次打开后才挂载，之后收起只隐藏，shell 会话保留到切换线程。
  const [terminalStarted, setTerminalStarted] = useState(false)
  const activeThreadId = state.activeThreadId
  // 草稿里也能打开右栏和底部终端（参照 ZCode）：它们挂在草稿的项目上，不建会话；
  // 第一次发送建好会话后原样交给它。草稿各自记着右栏、终端开没开，新草稿默认收起。
  // 插槽不随设置、插件、定时任务页变：离开聊天时右栏和终端只是收起，回来时不重新挂载。
  const draftProject = !state.activeThreadId ? draftProjectId(state) : null
  const inChat = view === "chat"
  const slot = useWorkspaceSlot(activeThreadId, draftProject)
  const { rightOpen, setRightOpen, terminalOpen, setTerminalOpen } = usePanelOpen(
    draftProject ? slot.key : null,
  )
  const [panels, setPanels] = useState<Record<string, PanelSurfaceState>>({})
  const [history, setHistory] = useState<NavHistory>(EMPTY_HISTORY)
  // 每次进入新会话草稿递增，草稿页据此把光标放回输入框。
  const [draftFocus, setDraftFocus] = useState(0)
  const [checkoutRevision, setCheckoutRevision] = useState(0)
  const onCheckoutChanged = useCallback(() => setCheckoutRevision((revision) => revision + 1), [])
  const initialLoadDone = useRef(false)
  const registeredSurfaces = useRef<ReadonlySet<string>>(new Set())

  // Surface 注销（插件停用或卸载）时关掉每个线程里它已经打开的标签，当前标签改选邻居。
  useEffect(() => {
    const current = new Set(surfaceContributions.map((surface) => surface.id))
    const removed = new Set([...registeredSurfaces.current].filter((id) => !current.has(id)))
    registeredSurfaces.current = current
    if (removed.size === 0) return
    setPanels((panels) => {
      let changed = false
      const next: Record<string, PanelSurfaceState> = {}
      for (const [threadId, panel] of Object.entries(panels)) {
        next[threadId] = closeRemovedSurfaces(panel, removed)
        if (next[threadId] !== panel) changed = true
      }
      return changed ? next : panels
    })
  }, [surfaceContributions])

  // 只在用户正看着设置时把退回的页记下来：不在设置里时页面暂时不在（插件重新加载、停用后又启用），
  // 选中的仍是原来的页，它回来后再打开设置还是它。
  useEffect(() => {
    if (view === "settings" && settingsPage !== selectedPage) setSelectedPage(settingsPage)
  }, [view, settingsPage, selectedPage])

  useEffect(() => {
    if (rightOpen) setRightStarted(true)
  }, [rightOpen])

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

  // 首次连上 Host 后拉取项目与线程；重连时保留当前界面状态。
  useEffect(() => {
    if (state.status !== "connected" || initialLoadDone.current) return
    initialLoadDone.current = true
    void loadWorkspace(connection, store).catch((error: unknown) => {
      initialLoadDone.current = false
      store.update({ error: messageOf(error) })
    })
  }, [state.status, connection, store])

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
  const activeEvents = activeThreadId ? state.threadStates[activeThreadId]?.events : undefined
  const activeRevision = useMemo(() => workspaceRevision(activeEvents ?? []), [activeEvents])

  function toggleRight(): void {
    if (!inChat || !slot.scope) return
    setRightOpen((value) => !value)
    setRightMaximized(false)
  }

  function toggleTerminal(): void {
    if (!inChat || !slot.scope) return
    setRightMaximized(false)
    setTerminalStarted(true)
    setTerminalOpen((value) => rightMaximized || !value)
  }

  /** 改一个面板的标签；key 是 slot key（会话 id，或者草稿的 key）。 */
  const updatePanel = useCallback(
    (key: string, update: (panel: PanelSurfaceState) => PanelSurfaceState) => {
      setPanels((current) => ({
        ...current,
        [key]: update(current[key] ?? EMPTY_SURFACE_STATE),
      }))
    },
    [],
  )

  const showRightPanel = useCallback(() => {
    setRightOpen(true)
    setRightMaximized(false)
  }, [setRightOpen])

  function browseProjectFiles(projectId: string): void {
    const key = slot.draftKeyOf(projectId)
    startDraft(projectId)
    updatePanel(key, (panel) =>
      addSurface(panel, "files", `files-${crypto.randomUUID()}`, () =>
        translate(locale, "workbench.files"),
      ),
    )
    setRightOpen(true, key)
    setRightMaximized(false)
  }

  // agent 调用浏览器工具时，main 让界面给它的线程开（或亮出）浏览器标签；正在看这个线程时展开右栏。
  useBrowserOpen({
    panels,
    keyOf: slot.keyOf,
    threadId: state.activeThreadId,
    view,
    setPanels,
    onOpenRight: showRightPanel,
    locale,
  })

  /** 从聊天里打开文件或 Diff：当前线程的右栏切到对应标签（文件在自己的标签里打开）并展开。 */
  function openSurface(kind: "file" | "diff", path?: string): void {
    const threadId = state.activeThreadId
    if (!threadId) return
    updatePanel(slot.keyOf(threadId), (panel) =>
      kind === "file" && path
        ? openFileSurface(panel, path, `file-${crypto.randomUUID()}`)
        : addSurface(panel, "diff", `diff-${crypto.randomUUID()}`, () => "Diff"),
    )
    showRightPanel()
  }

  const openLinkTab = useCallback(
    (url: string) => {
      if (!slot.key) return
      const id = `browser-${crypto.randomUUID()}`
      const title = new URL(url).host
      updatePanel(slot.key, (panel) => ({
        surfaces: [...panel.surfaces, { id, kind: "browser", title, url }],
        activeId: id,
      }))
      showRightPanel()
    },
    [slot.key, showRightPanel, updatePanel],
  )

  // 草稿里开的浏览器也挂着；它还不属于哪个会话，agent 用不了，建好会话后才交给那个会话的 agent。
  const { threadOf } = slot
  const browsers = useMemo(() => {
    const live = new Set(
      state.threads.filter((thread) => thread.archivedAt === null).map((thread) => thread.id),
    )
    return Object.entries(panels).flatMap(([key, panel]) => {
      const threadId = threadOf(key)
      if (threadId !== null && !live.has(threadId)) return []
      return panel.surfaces
        .filter((surface) => surface.kind === "browser")
        .map((surface) => ({ id: surface.id, slotKey: key, threadId, initialUrl: surface.url }))
    })
  }, [panels, state.threads, threadOf])

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
      onRenameThread={(threadId, title) => {
        void renameThread(connection, store, threadId, title).catch((error: unknown) =>
          store.update({ error: messageOf(error) }),
        )
      }}
      onReferenceThread={(thread) => {
        // 在当前会话（或草稿）的输入框里插入这个会话的引用；在设置等页面时先回到聊天。
        setView("chat")
        requestComposerThreadMention(thread.id, thread.title)
      }}
      onArchiveThread={(threadId) => {
        void archiveThread(connection, store, threadId)
          .then((next) => {
            if (next) openThread(next)
          })
          .catch((error: unknown) => store.update({ error: messageOf(error) }))
      }}
      onRenameProject={(projectId, name) => {
        void renameProject(connection, store, projectId, name).catch((error: unknown) =>
          store.update({ error: messageOf(error) }),
        )
      }}
      onRemoveProject={(projectId) => {
        void removeProject(connection, store, projectId)
          .then((next) => {
            if (next) openThread(next)
          })
          .catch((error: unknown) => store.update({ error: messageOf(error) }))
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
