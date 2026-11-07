/**
 * 应用外壳：Windows/Linux 的标题栏、侧栏顶行按钮、工作区/设置侧栏与内容区。
 * 窗口按钮全部由系统绘制：macOS 的交通灯落在侧栏顶行，Windows/Linux 的按钮叠在标题栏上。
 */
import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from "react"
import type { Project, Thread } from "@pigcode/contracts"
import { useExtensionRegistry } from "@pigcode/client-runtime"
import { Button, formatShortcut, useLocale, useSidebarGrouping } from "@pigcode/ui-primitives"
import { AddProjectDialog } from "./add-project-dialog"
import { registerBuiltinCommands } from "./builtin-commands"
import { CommandPalette } from "./command-palette"
import { Icon } from "./icon"
import { PanelResizer, SidebarResizer, useRightWidth, useSidebarWidth } from "./panel-resizer"
import { SidebarPanels } from "./plugin-panel"
import { SettingsSidebar } from "./settings-sidebar"
import { DEFAULT_SETTINGS_PAGE } from "./settings-view"
import type { ThreadStatus } from "./thread-status"
import { TitleBar } from "./title-bar"
import { titleBarMenus } from "./title-bar-menus"
import { WindowControls } from "./window-controls"
import {
  hasCustomTitleBar,
  historyStep,
  nativePlatform,
  threadShortcutIndex,
  useModifierHints,
  useNarrowWindow,
} from "./window-state"
import { WorkspaceSidebar, visibleThreads } from "./workspace-sidebar"

/** 顶层视图：聊天、设置、插件与定时任务。 */
export type ShellView = "chat" | "settings" | "plugins" | "schedules"

/** 外壳所需的数据与事件；项目/线程数据由 store 传入。 */
export interface ShellProps {
  view: ShellView
  projects: Project[]
  threads: Thread[]
  activeThreadId: string | null
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
  /** 创建项目；name 为 undefined 时用文件夹名。 */
  onAddProject: (path: string, name?: string) => void
  onToggleProject?: (projectId: string, expanded: boolean) => void
  onNewThread: (projectId?: string) => void
  onOpenThread: (threadId: string) => void
  /** 会话行右键菜单的重命名与归档；两个都传时才有右键菜单。 */
  onRenameThread?: (threadId: string, title: string) => void
  onArchiveThread?: (threadId: string) => void
  /** 项目行右键菜单的重命名与从侧栏移除；两个都传时才有右键菜单。 */
  onRenameProject?: (projectId: string, name: string) => void
  onRemoveProject?: (projectId: string) => void
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
  view,
  projects,
  threads,
  activeThreadId,
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
  onOpenThread,
  onRenameThread,
  onArchiveThread,
  onRenameProject,
  onRemoveProject,
  children,
}: ShellProps) {
  const { t } = useLocale()
  const registry = useExtensionRegistry()
  const [dialogOpen, setDialogOpen] = useState(false)
  const [paletteOpen, setPaletteOpen] = useState(false)
  const [rightWidth, setRightWidth] = useRightWidth()
  const [sidebarWidth, setSidebarWidth] = useSidebarWidth()
  const [localExpanded, setLocalExpanded] = useState<Record<string, boolean>>({})
  const [localSidebarOpen, setLocalSidebarOpen] = useState(true)
  // 插件页、定时任务页和聊天一样用工作区侧栏，侧栏里对应的入口高亮；只有设置换成设置侧栏。
  const inSettings = view === "settings"
  const platform = nativePlatform()
  const narrow = useNarrowWindow()
  const [drawerOpen, setDrawerOpen] = useState(false)
  const [grouping] = useSidebarGrouping()
  const shortcutHints = useModifierHints() && !inSettings
  const expanded = expandedProjects ?? localExpanded
  const open = sidebarOpen ?? localSidebarOpen
  const activePage = settingsPage ?? DEFAULT_SETTINGS_PAGE

  // 抽屉只在窄窗口里有意义；变宽后复位，下次变窄时从收起开始。
  useEffect(() => {
    if (!narrow) setDrawerOpen(false)
  }, [narrow])

  // 切到别的会话或页面后收起抽屉，回到内容。
  useEffect(() => {
    setDrawerOpen(false)
  }, [activeThreadId, view, settingsPage])

  useEffect(() => {
    if (!drawerOpen) return
    function onKeyDown(event: KeyboardEvent): void {
      if (event.key === "Escape") setDrawerOpen(false)
    }
    window.addEventListener("keydown", onKeyDown)
    return () => window.removeEventListener("keydown", onKeyDown)
  }, [drawerOpen])

  // 标题栏、交通灯留白和配色按平台区分，CSS 依赖 html[data-platform]；绘制前写入，避免布局跳动。
  useLayoutEffect(() => {
    document.documentElement.dataset.platform = platform
  }, [platform])

  // macOS 全屏时交通灯隐藏，CSS 依赖 html[data-fullscreen] 收回留白。
  useEffect(() => {
    const bridge = window.pigcodeNative
    if (!bridge?.onFullScreenChange) return
    const root = document.documentElement
    const apply = (fullScreen: boolean): void => {
      if (fullScreen) root.dataset.fullscreen = "true"
      else delete root.dataset.fullscreen
    }
    void bridge
      .isFullScreen?.()
      .then(apply)
      .catch(() => undefined)
    return bridge.onFullScreenChange(apply)
  }, [])

  // 全局快捷键：⌘K 面板、⌘N 新会话、⌘B 侧栏、⌘J 右栏、⌃` 底部终端、⌘, 设置。
  useEffect(() => {
    function onKeyDown(event: KeyboardEvent): void {
      if (event.ctrlKey && !event.metaKey && !event.altKey && event.code === "Backquote") {
        if (!onToggleTerminal) return
        event.preventDefault()
        onToggleTerminal()
        return
      }
      const target = event.target as HTMLElement | null
      const editing =
        target?.isContentEditable === true ||
        ["INPUT", "TEXTAREA", "SELECT"].includes(target?.tagName ?? "")
      // 输入框和终端里 Alt+方向键是按词移动，不拦截。
      const step = historyStep(event)
      if (step) {
        if (editing) return
        event.preventDefault()
        if (step === "back") onBack?.()
        else onForward?.()
        return
      }
      if (!event.metaKey && !event.ctrlKey) return
      const key = event.key.toLowerCase()
      if (key === "k") {
        event.preventDefault()
        // 对话框打开时不叠一层命令面板：面板会落在对话框下面，回车会在背后执行命令。
        if (document.querySelector(".dialog")) return
        setPaletteOpen((value) => !value)
        return
      }
      if (editing) return
      if (key === "n") {
        event.preventDefault()
        onNewThread()
      } else if (key === "b") {
        event.preventDefault()
        toggleSidebar()
      } else if (key === "j") {
        event.preventDefault()
        onToggleRight?.()
      } else if (event.key === ",") {
        event.preventDefault()
        onView("settings")
      }
    }
    window.addEventListener("keydown", onKeyDown)
    return () => window.removeEventListener("keydown", onKeyDown)
  }, [onNewThread, onToggleRight, onToggleTerminal, onView, onBack, onForward, sidebarOpen, narrow])

  // 鼠标侧键的后退与前进。
  useEffect(() => {
    function onMouseUp(event: MouseEvent): void {
      if (event.button === 3) onBack?.()
      else if (event.button === 4) onForward?.()
    }
    window.addEventListener("mouseup", onMouseUp)
    return () => window.removeEventListener("mouseup", onMouseUp)
  }, [onBack, onForward])

  // ⌘/Ctrl+1…9 打开侧栏里从上往下数的第 n 个会话，输入框里同样生效。
  useEffect(() => {
    if (inSettings) return
    function onKeyDown(event: KeyboardEvent): void {
      const index = threadShortcutIndex(event)
      if (index === null) return
      const target = visibleThreads(projects, threads, grouping, expanded)[index - 1]
      if (!target) return
      event.preventDefault()
      setDrawerOpen(false)
      onOpenThread(target.id)
    }
    window.addEventListener("keydown", onKeyDown)
    return () => window.removeEventListener("keydown", onKeyDown)
  }, [inSettings, projects, threads, grouping, expanded, onOpenThread])

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
  const commandActions = useRef({ onNewThread, onView, onToggleRight, toggleSidebar })
  useLayoutEffect(() => {
    commandActions.current = { onNewThread, onView, onToggleRight, toggleSidebar }
  })
  const hasToggleRight = onToggleRight !== undefined
  useEffect(() => {
    if (!registry) return undefined
    const latest = () => commandActions.current
    return registerBuiltinCommands(
      registry,
      {
        onNewThread: () => latest().onNewThread(),
        onAddProject: () => setDialogOpen(true),
        onSettings: () => latest().onView("settings"),
        onPlugins: () => latest().onView("plugins"),
        onToggleSidebar: () => latest().toggleSidebar(),
        ...(hasToggleRight ? { onToggleWorkbench: () => latest().onToggleRight?.() } : {}),
      },
      t,
    )
  }, [registry, t, hasToggleRight])

  const showRight = rightPanel !== undefined && rightOpen
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
          >
            <SidebarPanels />
          </SettingsSidebar>
        ) : (
          <WorkspaceSidebar
            projects={projects}
            threads={threads}
            activeThreadId={view === "chat" ? activeThreadId : null}
            threadStatus={threadStatus}
            agentNames={agentNames}
            expandedProjects={expanded}
            onAddProject={() => setDialogOpen(true)}
            onToggleProject={toggleProject}
            onOpenThread={(threadId) => {
              setDrawerOpen(false)
              onOpenThread(threadId)
            }}
            onNewThread={(projectId) => {
              setDrawerOpen(false)
              onNewThread(projectId)
            }}
            onOpenSchedules={() => onView("schedules")}
            onOpenPlugins={() => onView("plugins")}
            activeNav={view === "schedules" || view === "plugins" ? view : undefined}
            onRenameThread={onRenameThread}
            onArchiveThread={onArchiveThread}
            onRenameProject={onRenameProject}
            onRemoveProject={onRemoveProject}
            shortcutHints={shortcutHints}
          >
            <SidebarPanels />
          </WorkspaceSidebar>
        )}
        {!inSettings ? (
          <div className="side-foot">
            <span className="side-account">
              <span className="side-avatar" aria-hidden="true">
                <Icon name="snout" />
              </span>
              <span className="truncate">Pigcode</span>
            </span>
            <Button
              variant="plain"
              className="icon-btn foot-gear"
              type="button"
              aria-label={t("settings.title")}
              title={`${t("settings.title")} ${formatShortcut("Mod+,")}`}
              onClick={() => onView("settings")}
            >
              <Icon name="gear" />
            </Button>
          </div>
        ) : null}
      </aside>
      {open && !narrow ? <SidebarResizer width={sidebarWidth} onChange={setSidebarWidth} /> : null}
      <div className="drawer-scrim" aria-hidden="true" onClick={() => setDrawerOpen(false)} />
      <div className="workspace">
        <main className="panel">
          {children}
          {bottomPanel}
        </main>
        {rightPanel !== undefined ? (
          <div className="right-panel-slot" hidden={!showRight}>
            {showRight && !rightMaximized ? (
              <PanelResizer width={rightWidth} onChange={setRightWidth} />
            ) : null}
            {rightPanel}
          </div>
        ) : null}
      </div>
      <AddProjectDialog
        open={dialogOpen}
        onOpenChange={setDialogOpen}
        onAdd={(path, name) => onAddProject(path, name)}
      />
      <CommandPalette
        open={paletteOpen}
        onClose={() => setPaletteOpen(false)}
        projects={projects}
        threads={threads}
        activeThreadId={activeThreadId}
        onNewThread={(projectId) => onNewThread(projectId)}
        onOpenThread={onOpenThread}
      />
    </div>
  )
}
