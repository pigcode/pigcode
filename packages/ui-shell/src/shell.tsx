/** 应用外壳：窗口按钮、工作区/设置侧栏与内容区。 */
import { useEffect, useState, type ReactNode } from "react"
import type { Project, Thread } from "@pigcode/contracts"
import { useLocale } from "@pigcode/ui-primitives"
import { AddProjectDialog } from "./add-project-dialog"
import { SettingsSidebar, type SettingsSection } from "./settings-sidebar"
import { WindowControls } from "./window-controls"
import { WorkspaceSidebar } from "./workspace-sidebar"

/** 顶层视图：聊天、设置与插件。 */
export type ShellView = "chat" | "settings" | "plugins"

/** 外壳所需的数据与事件；项目/线程数据由 store 传入。 */
export interface ShellProps {
  view: ShellView
  projects: Project[]
  threads: Thread[]
  activeThreadId: string | null
  expandedProjects?: Record<string, boolean>
  sidebarOpen?: boolean
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
  expandedProjects,
  sidebarOpen,
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
  children,
}: ShellProps) {
  const { t } = useLocale()
  const [dialogOpen, setDialogOpen] = useState(false)
  const [localExpanded, setLocalExpanded] = useState<Record<string, boolean>>({})
  const [localSidebarOpen, setLocalSidebarOpen] = useState(true)
  const inSettings = view !== "chat"

  // 侧栏与窗口控件的间距按平台微调，CSS 依赖 html[data-platform]。
  useEffect(() => {
    if (typeof document !== "undefined") {
      document.documentElement.dataset.platform = window.pigcodeNative?.platform ?? ""
    }
  }, [])
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

  const appClass = ["app", open ? "" : "is-collapsed"].filter(Boolean).join(" ")

  return (
    <div
      className={appClass}
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
              expandedProjects={expanded}
              onAddProject={() => setDialogOpen(true)}
              onToggleProject={toggleProject}
              onOpenThread={onOpenThread}
              onNewThread={onNewThread}
              onOpenSettings={() => onView("settings")}
            />
          )}
        </div>
      </aside>
      <main className="panel">{children}</main>
      <AddProjectDialog
        open={dialogOpen}
        onOpenChange={setDialogOpen}
        onAdd={(path) => onAddProject(path)}
      />
    </div>
  )
}
