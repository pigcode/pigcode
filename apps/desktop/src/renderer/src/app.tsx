/** 应用外壳：把 store/connection 接到 Shell、聊天、设置与插件管理器。 */
import { Suspense, lazy, useEffect, useMemo, useRef, useState } from "react"
import type { Thread } from "@pigcode/contracts"
import { useAppStore, useContributions } from "@pigcode/client-runtime"
import { translate, useAppearance, type Locale } from "@pigcode/ui-primitives"
export type { ChatControls, CoreDeps } from "./chat-container"
import {
  AppRenderer,
  DEFAULT_SETTINGS_PAGE,
  SettingsView,
  settingsPageOrFallback,
  type ShellView,
  type ThreadStatus,
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
import { useAgentNames } from "./agents"
import { BrowserHost } from "./browser-host"
import { AppearanceContext } from "./builtin-settings-pages"
import { ChatViewContainer, type CoreDeps } from "./chat-container"
import { ConnectionBanner } from "./connection-banner"
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
import { NEW_THREAD_DRAFT_KEY, draftProjectId, materializeDraft } from "./new-thread-draft"
import { workspaceRevision } from "./workspace-revision"

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

const BUSY: ReadonlySet<ThreadStatus> = new Set(["running", "queued", "waiting-approval"])

/** 侧栏状态：主会话空闲但有子代理在忙时，主会话显示子代理的状态。 */
export function mergeChildStatus(
  threads: readonly Thread[],
  threadStates: Readonly<Record<string, { status: ThreadStatus }>>,
): Record<string, ThreadStatus> {
  const result: Record<string, ThreadStatus> = {}
  for (const [threadId, viewState] of Object.entries(threadStates)) {
    result[threadId] = viewState.status
  }
  for (const thread of threads) {
    if (!thread.parentThreadId || thread.archivedAt !== null) continue
    const status = threadStates[thread.id]?.status
    const parent = result[thread.parentThreadId]
    if (status && BUSY.has(status) && !(parent && BUSY.has(parent))) {
      result[thread.parentThreadId] = status
    }
  }
  return result
}

/** 应用根组件。 */
export function App({ store, connection, plugins, locale }: AppProps) {
  const state = useAppStore(store)
  const appearance = useAppearance()
  const surfaceContributions = useContributions("surface")
  const settingsPages = useContributions("settingsPage")
  const agentNames = useAgentNames(connection, state.agentRevision, state.status === "connected")
  const [view, setView] = useState<ShellView>("chat")
  const [selectedPage, setSelectedPage] = useState<string>(DEFAULT_SETTINGS_PAGE)
  // 选中的设置页被移除（插件停用或卸载）时退回通用页，内容区不留空白。
  const settingsPage = settingsPageOrFallback(settingsPages, selectedPage)
  const [rightOpen, setRightOpen] = useState(false)
  // 右栏第一次打开后才挂载（按需加载工作台代码），之后收起只隐藏，终端与浏览器标签保留。
  const [rightStarted, setRightStarted] = useState(false)
  const [rightMaximized, setRightMaximized] = useState(false)
  const [terminalOpen, setTerminalOpen] = useState(false)
  // 底部终端第一次打开后才挂载，之后收起只隐藏，shell 会话保留到切换线程。
  const [terminalStarted, setTerminalStarted] = useState(false)
  const [panels, setPanels] = useState<Record<string, PanelSurfaceState>>({})
  const [history, setHistory] = useState<NavHistory>(EMPTY_HISTORY)
  // 每次进入新会话草稿递增，草稿页据此把光标放回输入框。
  const [draftFocus, setDraftFocus] = useState(0)
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

  /**
   * 右栏和终端挂在会话上：在草稿里打开它们时先按草稿建会话（ZCode：必须挂在会话上的操作才建会话），
   * 建好再打开。返回这次是不是按草稿处理的。
   */
  function openFromDraft(target: "right" | "terminal"): boolean {
    if (view !== "chat" || store.getSnapshot().activeThreadId) return false
    void materializeDraft(connection, store, locale)
      .then(() => {
        if (target === "terminal") {
          setTerminalStarted(true)
          setTerminalOpen(true)
          return
        }
        setRightOpen(true)
        setRightMaximized(false)
      })
      .catch((error: unknown) => store.update({ error: messageOf(error) }))
    return true
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
  const activeThreadId = view === "chat" ? state.activeThreadId : null
  const activeProjectName =
    state.projects.find((project) => project.id === activeThread?.projectId)?.name ?? ""
  const activeEvents = activeThreadId ? state.threadStates[activeThreadId]?.events : undefined
  const activeRevision = useMemo(() => workspaceRevision(activeEvents ?? []), [activeEvents])

  // 草稿里有项目时布局按钮也能用：点了先建会话再打开。
  const draftReady = view === "chat" && !state.activeThreadId && draftProjectId(state) !== null

  function toggleRight(): void {
    if (openFromDraft("right")) return
    setRightOpen((value) => !value)
    setRightMaximized(false)
  }

  function toggleTerminal(): void {
    if (openFromDraft("terminal")) return
    if (!activeThreadId) return
    setTerminalStarted(true)
    setTerminalOpen((value) => !value)
  }

  function updatePanel(threadId: string, update: (panel: PanelSurfaceState) => PanelSurfaceState) {
    setPanels((current) => ({
      ...current,
      [threadId]: update(current[threadId] ?? EMPTY_SURFACE_STATE),
    }))
  }

  // agent 调用浏览器工具时，main 让这里给它的线程开（或亮出）浏览器标签；正在看这个线程时展开右栏。
  const openState = useRef({ panels, activeThreadId: state.activeThreadId, view })
  openState.current = { panels, activeThreadId: state.activeThreadId, view }
  useEffect(
    () =>
      window.pigcodeNative?.browser?.onOpen(({ threadId, url }) => {
        const existing = openState.current.panels[threadId]?.surfaces
          .filter((surface) => surface.kind === "browser")
          .at(-1)
        const id = existing?.id ?? `browser-${crypto.randomUUID()}`
        setPanels((current) => {
          const panel = current[threadId] ?? EMPTY_SURFACE_STATE
          return {
            ...current,
            [threadId]: panel.surfaces.some((surface) => surface.id === id)
              ? { ...panel, activeId: id }
              : {
                  surfaces: [
                    ...panel.surfaces,
                    {
                      id,
                      kind: "browser",
                      title: url ? new URL(url).host : translate(locale, "workbench.browser"),
                      ...(url ? { url } : {}),
                    },
                  ],
                  activeId: id,
                },
          }
        })
        const { activeThreadId, view: currentView } = openState.current
        if (threadId === activeThreadId && currentView === "chat") {
          setRightOpen(true)
          setRightMaximized(false)
        }
      }),
    [locale],
  )

  /** 从聊天里打开文件或 Diff：当前线程的右栏切到对应标签（文件在自己的标签里打开）并展开。 */
  function openSurface(kind: "file" | "diff", path?: string): void {
    const threadId = state.activeThreadId
    if (!threadId) return
    updatePanel(threadId, (panel) =>
      kind === "file" && path
        ? openFileSurface(panel, path, `file-${crypto.randomUUID()}`)
        : addSurface(panel, "diff", `diff-${crypto.randomUUID()}`, () => "Diff"),
    )
    setRightOpen(true)
    setRightMaximized(false)
  }

  const browsers = useMemo(() => {
    const live = new Set(
      state.threads.filter((thread) => thread.archivedAt === null).map((thread) => thread.id),
    )
    return Object.entries(panels).flatMap(([threadId, panel]) =>
      live.has(threadId)
        ? panel.surfaces
            .filter((surface) => surface.kind === "browser")
            .map((surface) => ({ id: surface.id, threadId, initialUrl: surface.url }))
        : [],
    )
  }, [panels, state.threads])

  const layoutControls = (maximizable: boolean) => (
    <PanelLayoutControls
      rightOpen={rightOpen && activeThreadId !== null}
      onToggleRight={toggleRight}
      terminalOpen={terminalOpen && activeThreadId !== null}
      onToggleTerminal={toggleTerminal}
      {...(maximizable
        ? {
            maximized: rightMaximized,
            onToggleMaximize: () => setRightMaximized((value) => !value),
          }
        : {})}
      disabled={!activeThreadId && !draftReady}
    />
  )

  return (
    <AppRenderer
      locale={locale}
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
      onOpenThread={openThread}
      onRenameThread={(threadId, title) => {
        void renameThread(connection, store, threadId, title).catch((error: unknown) =>
          store.update({ error: messageOf(error) }),
        )
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
      rightOpen={rightOpen}
      rightMaximized={rightMaximized}
      rightPanel={
        activeThreadId && (rightStarted || rightOpen) ? (
          <Suspense fallback={null}>
            <WorkbenchPanel
              key={activeThreadId}
              connection={connection}
              threadId={activeThreadId}
              panel={panels[activeThreadId] ?? EMPTY_SURFACE_STATE}
              onPanelChange={(update) => updatePanel(activeThreadId, update)}
              controls={layoutControls(true)}
              onError={(message) => store.update({ error: message })}
              projectName={activeProjectName}
              workspaceRevision={activeRevision}
            />
          </Suspense>
        ) : undefined
      }
      bottomPanel={
        activeThreadId && terminalStarted ? (
          <Suspense fallback={null}>
            <TerminalDrawer
              key={activeThreadId}
              connection={connection}
              threadId={activeThreadId}
              open={terminalOpen}
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
          updatePanel(browser.threadId, (panel) => updateSurface(panel, browser.id, patch))
        }
      />
      {view === "chat" ? (
        <ChatViewContainer
          deps={{ connection, store, plugins }}
          rightOpen={rightOpen}
          onToggleRight={toggleRight}
          layoutControls={rightOpen && activeThreadId ? null : layoutControls(false)}
          onOpenFile={(path: string) => openSurface("file", path)}
          onOpenDiff={() => openSurface("diff")}
          draftFocus={draftFocus}
        />
      ) : view === "plugins" ? (
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
          <SettingsView page={settingsPage} />
        </AppearanceContext.Provider>
      )}
    </AppRenderer>
  )
}
