/** 应用外壳：窗口按钮、工作区/设置侧栏与内容区。 */
import {
  useEffect,
  useState,
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from "react"
import type { Project, Thread } from "@pigcode/contracts"
import { useLocale } from "@pigcode/ui-primitives"
import { Button } from "@pigcode/ui-primitives"
import { AddProjectDialog } from "./add-project-dialog"
import { CommandPalette } from "./command-palette"
import { Icon } from "./icon"
import { SettingsSidebar, type SettingsSection } from "./settings-sidebar"
import type { ThreadTabStatus } from "./thread-tabs"
import { WindowControls } from "./window-controls"
import { WorkspaceSidebar } from "./workspace-sidebar"

/** 顶层视图：聊天、设置与插件。 */
export type ShellView = "chat" | "settings" | "plugins"

const RIGHT_MIN = 320
const RIGHT_MAX_RATIO = 0.58
const RIGHT_STORAGE_KEY = "pigcode.rightWidth"

/** 把右栏宽度限制在窗口可承受范围内。 */
function clampRightWidth(width: number): number {
  const max = Math.max(RIGHT_MIN, Math.round((typeof window === "undefined" ? 1200 : window.innerWidth) * RIGHT_MAX_RATIO))
  return Math.min(max, Math.max(RIGHT_MIN, Math.round(width)))
}

/** 读取上次保存的右栏宽度；存储不可用时回到默认值。 */
function initialRightWidth(): number {
  try {
    const saved = Number.parseInt(window.localStorage.getItem(RIGHT_STORAGE_KEY) ?? "", 10)
    if (Number.isFinite(saved)) return clampRightWidth(saved)
  } catch {
    // 隐私模式或测试环境可能禁用 localStorage；使用默认宽度。
  }
  return 460
}

/** 外壳所需的数据与事件；项目/线程数据由 store 传入。 */
export interface ShellProps {
  view: ShellView
  projects: Project[]
  threads: Thread[]
  activeThreadId: string | null
  /** 线程运行状态；用于侧栏和 tab 的状态点。 */
  threadStatus?: Record<string, ThreadTabStatus>
  expandedProjects?: Record<string, boolean>
  sidebarOpen?: boolean
  /** 右栏内容；由调用方按当前线程组装。 */
  rightPanel?: ReactNode
  /** 右栏是否展开；缺省视为展开。 */
  rightOpen?: boolean
  /** 右栏折叠切换；供调用方接入快捷键或头部按钮。 */
  onToggleRight?: () => void
  canGoBack?: boolean
  canGoForward?: boolean
  settingsSection?: SettingsSection
  onToggleSidebar?: () => void
  onBack?: () => void
  onForward?: () => void
  onView: (view: ShellView) => void
  onSettingsSection?: (section: SettingsSection) => void
  onAddProject: (path: string) => void
  onToggleProject?: (projectId: string, expanded: boolean) => void
  onNewThread: (projectId?: string) => void
  onOpenThread: (threadId: string) => void
  /** 侧栏底部扩展区，用于宿主渲染第三方 UI 插件面板。 */
  sidebarExtra?: ReactNode
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
  expandedProjects,
  sidebarOpen,
  rightPanel,
  rightOpen = true,
  onToggleRight,
  canGoBack = false,
  canGoForward = false,
  settingsSection,
  onToggleSidebar,
  onBack,
  onForward,
  onView,
  onSettingsSection,
  onAddProject,
  onToggleProject,
  onNewThread,
  onOpenThread,
  sidebarExtra,
  children,
}: ShellProps) {
  const { t } = useLocale()
  const [dialogOpen, setDialogOpen] = useState(false)
  const [paletteOpen, setPaletteOpen] = useState(false)
  const [rightWidth, setRightWidth] = useState(initialRightWidth)
  const [localExpanded, setLocalExpanded] = useState<Record<string, boolean>>({})
  const [localSidebarOpen, setLocalSidebarOpen] = useState(true)
  const inSettings = view !== "chat"

  // 侧栏与窗口控件的间距按平台微调，CSS 依赖 html[data-platform]。
  useEffect(() => {
    if (typeof document !== "undefined") {
      document.documentElement.dataset.platform = window.pigcodeNative?.platform ?? ""
    }
  }, [])

  // 记住工作台宽度；窗口变窄时重新夹紧，避免右栏挤掉主内容。
  useEffect(() => {
    try {
      window.localStorage.setItem(RIGHT_STORAGE_KEY, String(rightWidth))
    } catch {
      // 存储不可用时不阻塞界面。
    }
  }, [rightWidth])

  useEffect(() => {
    function handleResize(): void {
      setRightWidth((width) => clampRightWidth(width))
    }
    window.addEventListener("resize", handleResize)
    return () => window.removeEventListener("resize", handleResize)
  }, [])

  // 全局快捷键：⌘K 面板、⌘N 新会话、⌘B 侧栏、⌘J 工作台、⌘, 设置。
  useEffect(() => {
    function onKeyDown(event: KeyboardEvent): void {
      if (!event.metaKey && !event.ctrlKey) return
      const target = event.target as HTMLElement | null
      const editing =
        target?.isContentEditable === true ||
        ["INPUT", "TEXTAREA", "SELECT"].includes(target?.tagName ?? "")
      const key = event.key.toLowerCase()
      if (key === "k") {
        event.preventDefault()
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
  }, [onNewThread, onToggleRight, onView, sidebarOpen])

  const expanded = expandedProjects ?? localExpanded
  const open = sidebarOpen ?? localSidebarOpen
  const section: SettingsSection = settingsSection ?? (view === "plugins" ? "plugins" : "general")

  function toggleSidebar(): void {
    if (sidebarOpen === undefined) setLocalSidebarOpen((current) => !current)
    onToggleSidebar?.()
  }

  function toggleProject(projectId: string, next: boolean): void {
    if (expandedProjects === undefined) {
      setLocalExpanded((current) => ({ ...current, [projectId]: next }))
    }
    onToggleProject?.(projectId, next)
  }

  function selectSection(next: SettingsSection): void {
    onSettingsSection?.(next)
    onView(next === "plugins" ? "plugins" : "settings")
  }

  const showRight = rightPanel !== undefined && rightOpen
  const appClass = ["app", open ? "" : "is-collapsed", showRight ? "has-right" : ""]
    .filter(Boolean)
    .join(" ")
  const appStyle = { "--right-w": `${rightWidth}px` } as CSSProperties

  /** 拖动右栏分隔条；向左拖变宽，向右拖变窄。 */
  function startResize(event: ReactPointerEvent<HTMLDivElement>): void {
    event.preventDefault()
    const startX = event.clientX
    const startWidth = rightWidth
    const move = (moveEvent: PointerEvent): void => {
      setRightWidth(clampRightWidth(startWidth + startX - moveEvent.clientX))
    }
    const up = (): void => {
      window.removeEventListener("pointermove", move)
      window.removeEventListener("pointerup", up)
      document.body.classList.remove("is-resizing")
    }
    window.addEventListener("pointermove", move)
    window.addEventListener("pointerup", up)
    document.body.classList.add("is-resizing")
  }

  function onResizerKey(event: ReactKeyboardEvent<HTMLDivElement>): void {
    if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return
    event.preventDefault()
    setRightWidth((width) => clampRightWidth(width + (event.key === "ArrowLeft" ? 24 : -24)))
  }

  return (
    <div
      className={appClass}
      style={appStyle}
      data-platform={typeof window === "undefined" ? "" : (window.pigcodeNative?.platform ?? "")}
    >
      <WindowControls
        sidebarOpen={open}
        canGoBack={canGoBack}
        canGoForward={canGoForward}
        onToggleSidebar={toggleSidebar}
        onBack={() => onBack?.()}
        onForward={() => onForward?.()}
      />
      <aside className="sidebar" aria-label={inSettings ? t("settings.title") : t("nav.projects")}>
        <div className="side-top" />
        <div className="side-scroll">
          <div className="side-brand">
            <span className="brand-mark" aria-hidden="true">
              <Icon name="snout" />
            </span>
            <span className="brand-copy">
              <strong>Pigcode</strong>
              <small>Claude · Codex</small>
            </span>
            <button
              type="button"
              className="brand-command"
              aria-label={t("palette.placeholder")}
              title={`${t("palette.placeholder")} ⌘K`}
              onClick={() => setPaletteOpen(true)}
            >
              <Icon name="search" small />
            </button>
          </div>
          {inSettings ? (
            <SettingsSidebar
              activeSection={section}
              onSelect={selectSection}
              onExit={() => onView("chat")}
            />
          ) : (
            <WorkspaceSidebar
              projects={projects}
              threads={threads}
              activeThreadId={activeThreadId}
              threadStatus={threadStatus}
              expandedProjects={expanded}
              onAddProject={() => setDialogOpen(true)}
              onToggleProject={toggleProject}
              onOpenThread={onOpenThread}
              onNewThread={onNewThread}
              onOpenSettings={() => onView("settings")}
              onSearch={() => setPaletteOpen(true)}
            />
          )}
          {sidebarExtra}
          {!inSettings ? (
            <div className="side-foot">
              <Button
                variant="plain"
                className="side-settings"
                type="button"
                aria-label={t("settings.title")}
                onClick={() => onView("settings")}
              >
                <Icon name="gear" />
                <span className="grow">{t("settings.title")}</span>
                <span className="nav-kbd">⌘,</span>
              </Button>
            </div>
          ) : null}
        </div>
      </aside>
      <main className="panel">{children}</main>
      {showRight ? (
        <div className="right-panel-slot">
          <div
            className="panel-resizer"
            role="separator"
            aria-orientation="vertical"
            aria-label={t("palette.toggleWorkbench")}
            aria-valuemin={RIGHT_MIN}
            aria-valuemax={clampRightWidth(Number.MAX_SAFE_INTEGER)}
            aria-valuenow={rightWidth}
            tabIndex={0}
            onPointerDown={startResize}
            onKeyDown={onResizerKey}
            onDoubleClick={() => setRightWidth(clampRightWidth(460))}
          />
          {rightPanel}
        </div>
      ) : null}
      <AddProjectDialog
        open={dialogOpen}
        onOpenChange={setDialogOpen}
        onAdd={(path) => onAddProject(path)}
      />
      <CommandPalette
        open={paletteOpen}
        onClose={() => setPaletteOpen(false)}
        projects={projects}
        threads={threads}
        activeThreadId={activeThreadId}
        onNewThread={() => onNewThread()}
        onOpenThread={onOpenThread}
        onAddProject={() => setDialogOpen(true)}
        onSettings={() => onView("settings")}
        onPlugins={() => onView("plugins")}
        onToggleSidebar={toggleSidebar}
        {...(onToggleRight ? { onToggleWorkbench: () => onToggleRight() } : {})}
      />
    </div>
  )
}
