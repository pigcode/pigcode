/**
 * 应用外壳：Windows/Linux 的标题栏、侧栏顶行按钮、工作区/设置侧栏与内容区。
 * 窗口按钮全部由系统绘制：macOS 的交通灯落在侧栏顶行，Windows/Linux 的按钮叠在标题栏上。
 */
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from "react"
import {
  HOST_LOCAL_ID,
  type HostBrowseDirsResult,
  type HostSummary,
  type Project,
  type Thread,
} from "@pigcode/contracts"
import { useExtensionRegistry } from "@pigcode/client-runtime"
import { useLocale } from "@pigcode/ui-primitives"
import { registerBuiltinCommands } from "./builtin-commands"
import { PanelResizer, SidebarResizer, useShellPanelWidths } from "./panel-resizer"
import { SidebarPanels } from "./plugin-panel"
import { SettingsSidebar } from "./settings-sidebar"
import { ShellOverlays, ShellSidebarFooter } from "./shell-sidebar-footer"
import { DEFAULT_SETTINGS_PAGE } from "./settings-view"
import type { ThreadStatus } from "./thread-status"
import { TitleBar } from "./title-bar"
import { titleBarMenus } from "./title-bar-menus"
import { useShellShortcuts } from "./use-shell-shortcuts"
import { WindowControls } from "./window-controls"
import {
  hasCustomTitleBar,
  nativePlatform,
  useModifierHints,
  useNarrowWindow,
} from "./window-state"
import { WorkspaceSidebar, useHeldThread, type SidebarActionProps } from "./workspace-sidebar"

/** 顶层视图：聊天、设置与定时任务（插件与 Agent 管理在设置内按主机配置）。 */
export type ShellView = "chat" | "settings" | "schedules"

/** 没传 threadStatus 时用的同一个空表，快捷键的监听不会每次渲染都重新挂。 */
const NO_STATUS: Readonly<Record<string, ThreadStatus>> = {}

/** 外壳所需的数据与事件；项目/线程数据由 store 传入。 */
export interface ShellProps extends SidebarActionProps {
  updates?: ReactNode
  view: ShellView
  projects: Project[]
  threads: Thread[]
  activeThreadId: string | null
  hosts?: readonly HostSummary[] | undefined
  activeHostId?: string | undefined
  settingsHostId?: string | undefined
  onSelectSettingsHost?: ((hostId: string) => void) | undefined
  hostOfProject?: Readonly<Record<string, HostSummary>> | undefined
  hostOfThread?: Readonly<Record<string, HostSummary>> | undefined
  browseRemoteDirs?: ((hostId: string, path?: string) => Promise<HostBrowseDirsResult>) | undefined
  onOpenHostsSettings?: (() => void) | undefined
  onOpenAddHost?: (() => void) | undefined
  /** 线程运行状态；用于侧栏的状态点。 */
  threadStatus?: Record<string, ThreadStatus>
  /** agent 的显示名，按 agent id；侧栏会话行的 agent 缩写由它得出。 */
  agentNames?: Readonly<Record<string, string>>
  expandedProjects?: Record<string, boolean>
  sidebarOpen?: boolean
  /** 右栏内容；由调用方按当前线程组装。收起时只隐藏，不卸载，终端与页面得以保留。 */
  rightPanel?: ReactNode
  /** 右栏是否展开；缺省视为展开。 */
  rightOpen?: boolean
  /** 右栏占满工作区，聊天区暂时隐藏。 */
  rightMaximized?: boolean
  /** 右栏折叠切换；供调用方接入快捷键或头部按钮。 */
  onToggleRight?: () => void
  /** 聊天区下方的抽屉，例如底部终端。 */
  bottomPanel?: ReactNode
  /** 底部终端切换；接入 ⌃` 快捷键。 */
  onToggleTerminal?: () => void
  canGoBack?: boolean
  canGoForward?: boolean
  /** 当前设置页的 id（设置页扩展点）。 */
  settingsPage?: string
  onToggleSidebar?: () => void
  onBack?: () => void
  onForward?: () => void
  onView: (view: ShellView) => void
  onSettingsPage?: (page: string) => void
  /** 创建项目；name 为 undefined 时用文件夹名，hostId 指定归属主机。 */
  onAddProject: (path: string, name?: string, hostId?: string) => void
  onToggleProject?: (projectId: string, expanded: boolean) => void
  onNewThread: (projectId?: string) => void
  onBrowseFiles?: ((projectId: string) => void) | undefined
  onOpenThread: (threadId: string) => void
  children?: ReactNode
}

/** 普通页面的内容区：顶栏拖动区加可滚动区域。 */
export function ScrollPanel({ children }: { children: ReactNode }) {
  return (
    <section className="view">
      <PanelTop />
      <div className="panel-scroll">{children}</div>
    </section>
  )
}

/** 内容区顶栏，只放拖动区和可选操作。 */
export function PanelTop({ children }: { children?: ReactNode }) {
  return (
    <div className="panel-top">
      <span className="spacer" />
      {children}
    </div>
  )
}

/**
 * 组合窗口外壳。受控 props（expandedProjects/sidebarOpen）存在时由调用方管理，
 * 否则使用组件内部状态，方便 M0-B 的集成阶段逐步接管。
 */
export function Shell({
  updates,
  view,
  projects,
  threads,
  activeThreadId,
  hosts,
  activeHostId,
  settingsHostId,
  onSelectSettingsHost,
  hostOfProject,
  hostOfThread,
  browseRemoteDirs,
  onOpenHostsSettings,
  onOpenAddHost,
  threadStatus,
  agentNames,
  expandedProjects,
  sidebarOpen,
  rightPanel,
  rightOpen = true,
  rightMaximized = false,
  onToggleRight,
  bottomPanel,
  onToggleTerminal,
  canGoBack = false,
  canGoForward = false,
  settingsPage,
  onToggleSidebar,
  onBack,
  onForward,
  onView,
  onSettingsPage,
  onAddProject,
  onToggleProject,
  onNewThread,
  onBrowseFiles,
  onOpenThread,
  onRenameThread,
  onArchiveThread,
  onSetThreadPinned,
  onUnarchiveThread,
  onMarkThreadRead,
  onMarkAllRead,
  onReferenceThread,
  onRenameProject,
  onRemoveProject,
  children,
}: ShellProps) {
  const { t } = useLocale()
  const registry = useExtensionRegistry()
  const [dialogOpen, setDialogOpen] = useState(false)
  const [dialogHostId, setDialogHostId] = useState<string | undefined>(undefined)
  const openAddProjectDialog = useCallback(
    (hostId?: string) => {
      setDialogHostId(hostId ?? activeHostId ?? HOST_LOCAL_ID)
      setDialogOpen(true)
    },
    [activeHostId],
  )
  const [paletteOpen, setPaletteOpen] = useState(false)
  const [localExpanded, setLocalExpanded] = useState<Record<string, boolean>>({})
  const [localSidebarOpen, setLocalSidebarOpen] = useState(true)
  // 插件页、定时任务页和聊天一样用工作区侧栏，侧栏里对应的入口高亮；只有设置换成设置侧栏。
  const inSettings = view === "settings"
  const platform = nativePlatform()
  const narrow = useNarrowWindow()
  const [drawerOpen, setDrawerOpen] = useState(false)
  const statusOf = threadStatus ?? NO_STATUS
  const heldThreadId = useHeldThread(view === "chat" ? activeThreadId : null, threads, statusOf)
  const shortcutHints = useModifierHints() && !inSettings
  const expanded = expandedProjects ?? localExpanded
  const open = sidebarOpen ?? localSidebarOpen
  const activePage = settingsPage ?? DEFAULT_SETTINGS_PAGE
  const showRight = rightPanel !== undefined && rightOpen
  const { sidebarWidth, sidebarMax, setSidebarWidth, rightWidth, rightMax, setRightWidth } =
    useShellPanelWidths({
      sidebarDocked: open && !narrow,
      rightDocked: showRight && !rightMaximized && !narrow,
    })

  // 抽屉只在窄窗口里有意义；变宽后复位，下次变窄时从收起开始。
  useEffect(() => {
    if (!narrow) setDrawerOpen(false)
  }, [narrow])

  // 切到别的会话或页面后收起抽屉，回到内容。
  useEffect(() => {
    setDrawerOpen(false)
  }, [activeThreadId, view, settingsPage])

  useShellShortcuts({
    platform,
    drawerOpen,
    setDrawerOpen,
    setPaletteOpen,
    toggleSidebar,
    sidebarOpen,
    narrow,
    onNewThread,
    onToggleRight,
    onToggleTerminal,
    onView,
    onBack,
    onForward,
  })

  const openWorkspaceThread = useCallback(
    (threadId: string) => {
      setDrawerOpen(false)
      onOpenThread(threadId)
    },
    [onOpenThread],
  )

  /** 宽窗口里收起或展开侧栏；窄窗口里开关抽屉。 */
  function toggleSidebar(): void {
    if (narrow) {
      setDrawerOpen((current) => !current)
      return
    }
    if (sidebarOpen === undefined) setLocalSidebarOpen((current) => !current)
    onToggleSidebar?.()
  }

  function toggleProject(projectId: string, next: boolean): void {
    if (expandedProjects === undefined) {
      setLocalExpanded((current) => ({ ...current, [projectId]: next }))
    }
    onToggleProject?.(projectId, next)
  }

  /** 打开一个设置页。 */
  function selectPage(page: string): void {
    onSettingsPage?.(page)
    onView("settings")
  }

  // 内置命令走 Command 扩展点：命令面板和输入框 `/` 都从注册表读取。调用方每次渲染都可能传来新的
  // 回调，命令通过 ref 调用最新的那个；只有语言变化（关键词跟着变）或右侧面板开关出现、消失时才重新登记。
  const commandActions = useRef({
    onNewThread,
    onView,
    onSettingsPage,
    onToggleRight,
    toggleSidebar,
    openAddProjectDialog,
  })
  useLayoutEffect(() => {
    commandActions.current = {
      onNewThread,
      onView,
      onSettingsPage,
      onToggleRight,
      toggleSidebar,
      openAddProjectDialog,
    }
  })
  const hasToggleRight = onToggleRight !== undefined
  useEffect(() => {
    if (!registry) return undefined
    const latest = () => commandActions.current
    return registerBuiltinCommands(
      registry,
      {
        onNewThread: () => latest().onNewThread(),
        onAddProject: () => latest().openAddProjectDialog(),
        onSettings: () => latest().onView("settings"),
        onPlugins: () => {
          latest().onSettingsPage?.("plugins")
          latest().onView("settings")
        },
        onToggleSidebar: () => latest().toggleSidebar(),
        ...(hasToggleRight ? { onToggleWorkbench: () => latest().onToggleRight?.() } : {}),
      },
      t,
    )
  }, [registry, t, hasToggleRight])

  const appClass = [
    "app",
    open ? "" : "is-collapsed",
    narrow && drawerOpen ? "is-drawer-open" : "",
    showRight ? "has-right" : "",
    showRight && rightMaximized ? "is-right-max" : "",
  ]
    .filter(Boolean)
    .join(" ")
  const appStyle = {
    "--sidebar-w": `${sidebarWidth}px`,
    "--right-w": `${rightWidth}px`,
  } as CSSProperties

  const menus = hasCustomTitleBar(platform)
    ? titleBarMenus({
        t,
        newThread: () => onNewThread(),
        addProject: () => setDialogOpen(true),
        settings: () => onView("settings"),
        about: () => selectPage("general"),
        palette: () => setPaletteOpen(true),
        toggleSidebar,
        toggleRight: onToggleRight,
        toggleTerminal: onToggleTerminal,
      })
    : null

  return (
    <div className={appClass} style={appStyle}>
      {menus ? <TitleBar menus={menus} label={t("menu.label")} /> : null}
      <WindowControls
        updates={updates}
        sidebarOpen={narrow ? drawerOpen : open}
        canGoBack={canGoBack}
        canGoForward={canGoForward}
        onToggleSidebar={toggleSidebar}
        onSearch={() => setPaletteOpen(true)}
        onBack={() => onBack?.()}
        onForward={() => onForward?.()}
      />
      <aside
        className={shortcutHints ? "sidebar show-shortcuts" : "sidebar"}
        aria-label={inSettings ? t("settings.title") : t("nav.projects")}
      >
        <div className="side-top" />
        {inSettings ? (
          <SettingsSidebar
            activePage={activePage}
            onSelect={selectPage}
            onExit={() => onView("chat")}
            hosts={hosts}
            settingsHostId={settingsHostId}
            onSelectSettingsHost={onSelectSettingsHost}
          >
            <SidebarPanels />
          </SettingsSidebar>
        ) : (
          <WorkspaceSidebar
            projects={projects}
            threads={threads}
            activeThreadId={view === "chat" ? activeThreadId : null}
            hosts={hosts}
            hostOfProject={hostOfProject}
            hostOfThread={hostOfThread}
            threadStatus={threadStatus}
            agentNames={agentNames}
            expandedProjects={expanded}
            onAddProject={() => openAddProjectDialog()}
            onAddProjectOnHost={(hostId) => openAddProjectDialog(hostId)}
            onToggleProject={toggleProject}
            onOpenThread={openWorkspaceThread}
            onNewThread={(projectId) => {
              setDrawerOpen(false)
              onNewThread(projectId)
            }}
            onBrowseFiles={
              onBrowseFiles
                ? (projectId) => {
                    setDrawerOpen(false)
                    onBrowseFiles(projectId)
                  }
                : undefined
            }
            onOpenSchedules={() => onView("schedules")}
            activeNav={view === "schedules" ? "schedules" : undefined}
            onRenameThread={onRenameThread}
            onArchiveThread={onArchiveThread}
            onSetThreadPinned={onSetThreadPinned}
            onUnarchiveThread={onUnarchiveThread}
            onMarkThreadRead={onMarkThreadRead}
            onMarkAllRead={onMarkAllRead}
            onReferenceThread={onReferenceThread}
            onRenameProject={onRenameProject}
            onRemoveProject={onRemoveProject}
            heldThreadId={heldThreadId}
            shortcutHints={shortcutHints}
            enableThreadShortcuts
          >
            <SidebarPanels />
          </WorkspaceSidebar>
        )}
        {!inSettings ? (
          <ShellSidebarFooter
            hosts={hosts}
            activeHostId={activeHostId}
            onOpenHostsSettings={() =>
              onOpenHostsSettings ? onOpenHostsSettings() : selectPage("remote-hosts")
            }
            onOpenAddHost={onOpenAddHost}
            onOpenSettings={() => onView("settings")}
          />
        ) : null}
      </aside>
      {open && !narrow ? (
        <SidebarResizer width={sidebarWidth} max={sidebarMax} onChange={setSidebarWidth} />
      ) : null}
      <div className="drawer-scrim" aria-hidden="true" onClick={() => setDrawerOpen(false)} />
      {rightPanel !== undefined ? (
        <div
          className="right-scrim"
          aria-hidden="true"
          onClick={() => {
            if (narrow && showRight && !rightMaximized) onToggleRight?.()
          }}
        />
      ) : null}
      <div className="workspace">
        <main className="panel">
          {children}
          {bottomPanel}
        </main>
        {rightPanel !== undefined ? (
          <div className="right-panel-slot" hidden={!showRight}>
            {showRight && !rightMaximized && !narrow ? (
              <PanelResizer width={rightWidth} max={rightMax} onChange={setRightWidth} />
            ) : null}
            {rightPanel}
          </div>
        ) : null}
      </div>
      <ShellOverlays
        dialogOpen={dialogOpen}
        onDialogOpenChange={setDialogOpen}
        paletteOpen={paletteOpen}
        onPaletteClose={() => setPaletteOpen(false)}
        hosts={hosts}
        targetHostId={dialogHostId}
        browseRemoteDirs={browseRemoteDirs}
        projects={projects}
        threads={threads}
        activeThreadId={activeThreadId}
        onAddProject={onAddProject}
        onNewThread={onNewThread}
        onOpenThread={onOpenThread}
      />
    </div>
  )
}
