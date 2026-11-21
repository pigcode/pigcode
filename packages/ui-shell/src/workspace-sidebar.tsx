/**
 * 工作区侧栏：固定在上面的主导航，下面滚动的项目与会话列表。会话按项目、更新时间或状态分组，
 * 怎么分、怎么排、显示什么和筛选在标题旁的「自定义侧栏」菜单里改（sidebar-menu.tsx），
 * 规则在 sidebar-arrangement.ts。按项目分组时项目可以拖动，或者从右键菜单上移、下移。
 */
import { useEffect, useState, type DragEvent, type ReactNode } from "react"
import type { Project, Thread } from "@pigcode/contracts"
import {
  Button,
  EmptyState,
  AgentIcon,
  ListRow,
  formatShortcut,
  useLocale,
  useSidebarGrouping,
  useSidebarView,
  type MessageKey,
} from "@pigcode/ui-primitives"
import { Icon } from "./icon"
import { openFolder, useOpenFailure } from "./open-in"
import { SideScroll } from "./side-scroll"
import {
  filtersActive,
  moveProject,
  projectOrder,
  sidebarSections,
  threadCategory,
  type SidebarSection,
} from "./sidebar-arrangement"
import { SidebarMenu } from "./sidebar-menu"
import { projectMenu, threadMenu } from "./sidebar-row-menus"
import {
  PROJECT_DRAG_TYPE,
  ProjectRow,
  ThreadRow,
  type RenameHandlers,
  type RowAction,
} from "./sidebar-rows"
import type { ThreadStatus } from "./thread-status"
import { useToast } from "./toast"

/** 工作区侧栏所需的数据与事件；数据由 store 传入。 */
export interface WorkspaceSidebarProps {
  projects: Project[]
  threads: Thread[]
  activeThreadId: string | null
  threadStatus?: Record<string, ThreadStatus> | undefined
  /** agent 的显示名，按 agent id；会话行上的 agent 缩写由它得出，缺少时用 id。 */
  agentNames?: Readonly<Record<string, string>> | undefined
  expandedProjects: Record<string, boolean>
  onAddProject: () => void
  onToggleProject: (projectId: string, expanded: boolean) => void
  onOpenThread: (threadId: string) => void
  onNewThread: (projectId?: string) => void
  onBrowseFiles?: ((projectId: string) => void) | undefined
  onOpenSettings?: () => void
  /** 定时任务入口；不传时不显示。 */
  onOpenSchedules?: () => void
  /** 插件入口；不传时不显示。 */
  onOpenPlugins?: () => void
  /** 正在看的顶层页面：定时任务页或插件页，对应的入口高亮。 */
  activeNav?: "schedules" | "plugins" | undefined
  /** 会话行右键菜单里的重命名与归档；两个都传时才有菜单。 */
  onRenameThread?: ((threadId: string, title: string) => void) | undefined
  onArchiveThread?: ((threadId: string) => void) | undefined
  /** 已归档的会话右键菜单里的「取消归档」；不传时没有这一项。 */
  onUnarchiveThread?: ((threadId: string) => void) | undefined
  /** 会话行右键菜单里的「标为已读 / 标为未读」；不传时没有这一项。 */
  onMarkThreadRead?: ((threadId: string, read: boolean) => void) | undefined
  /** 侧栏菜单最后的「全部标为已读」；不传时没有这一项。 */
  onMarkAllRead?: (() => void) | undefined
  /** 会话行右键菜单里的「在输入框里引用」（#81）；不传时没有这一项。 */
  onReferenceThread?: ((thread: Thread) => void) | undefined
  /** 项目行右键菜单里的重命名与移除；两个都传时才有菜单，菜单里另有「在文件管理器中打开」。 */
  onRenameProject?: ((projectId: string, name: string) => void) | undefined
  onRemoveProject?: ((projectId: string) => void) | undefined
  /** 正在看、刚从「需要处理」里打开的会话，见 useHeldThread。 */
  heldThreadId?: string | null | undefined
  /** 按住 ⌘/Ctrl 时在前九个会话上显示数字快捷键。 */
  shortcutHints?: boolean
  /** 排在列表最后、跟着列表滚动的内容，例如插件的 Panel。 */
  children?: ReactNode
}

/**
 * 从「需要处理」里打开一个跑完没看的会话，它马上变成已读。看着它的时候先留在原处，换到别的会话再归位，
 * 行不会从手底下跳走（Cursor 的 heldNeedsAttentionAgentId）。
 */
export function useHeldThread(
  activeThreadId: string | null,
  threads: readonly Thread[],
  status: Readonly<Record<string, ThreadStatus>>,
): string | null {
  const [held, setHeld] = useState<{ active: string | null; id: string | null }>({
    active: activeThreadId,
    id: null,
  })
  if (held.active === activeThreadId) return held.id
  const thread = threads.find((item) => item.id === activeThreadId)
  const unread =
    thread !== undefined &&
    threadCategory(thread, status[thread.id] ?? thread.status ?? "idle") === "unread"
  const id = unread ? thread.id : null
  setHeld({ active: activeThreadId, id })
  return id
}

/** 每分钟刷新一次的当前时间，让「刚刚 / 3分钟」这类相对时间跟着走。 */
function useMinuteClock(): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 60_000)
    return () => clearInterval(timer)
  }, [])
  return now
}

/** 拖到项目的上半截放在它前面，下半截放在它后面。 */
function dropPlace(event: DragEvent<HTMLElement>): "before" | "after" {
  const box = event.currentTarget.getBoundingClientRect()
  return event.clientY > box.top + box.height / 2 ? "after" : "before"
}

/** 绘制工作区导航，不读取会话内核。 */
export function WorkspaceSidebar({
  projects,
  threads,
  activeThreadId,
  threadStatus = {},
  agentNames = {},
  expandedProjects,
  onAddProject,
  onToggleProject,
  onOpenThread,
  onNewThread,
  onBrowseFiles,
  onOpenSchedules,
  onOpenPlugins,
  activeNav,
  onRenameThread,
  onArchiveThread,
  onUnarchiveThread,
  onMarkThreadRead,
  onMarkAllRead,
  onReferenceThread,
  onRenameProject,
  onRemoveProject,
  heldThreadId = null,
  shortcutHints = false,
  children,
}: WorkspaceSidebarProps) {
  const { t } = useLocale()
  const toast = useToast()
  const openFailed = useOpenFailure()
  const [grouping, setGrouping] = useSidebarGrouping()
  const [view, setView] = useSidebarView()
  const now = useMinuteClock()
  // 同一时间只有一行在改名；项目与会话的 id 前缀不同，不会撞上。
  const [renamingId, setRenamingId] = useState<string | null>(null)
  const [dragging, setDragging] = useState<string | null>(null)
  const [drop, setDrop] = useState<{ id: string; place: "before" | "after" } | null>(null)
  const projectNames = new Map(projects.map((project) => [project.id, project.name]))
  const sections = sidebarSections(projects, threads, {
    grouping,
    view,
    status: threadStatus,
    expandedProjects,
    heldThreadId,
    now,
  })
  const order = sections.flatMap((section) =>
    section.kind === "project" && !section.open ? [] : section.threads,
  )
  const shortcutIndex = new Map(order.slice(0, 9).map((thread, index) => [thread.id, index + 1]))
  const projectIds = sections.flatMap((section) =>
    section.kind === "project" ? [section.project.id] : [],
  )

  /** 挪动项目就是手动排序了，和 Cursor 一样顺手把项目的排序切到「手动」。 */
  const reorder = (id: string, target: string, place: "before" | "after") =>
    setView({
      projectOrder: "manual",
      projectIds: moveProject(projectOrder(projects, threads, view), id, target, place),
    })

  /** 改名中的那一行拿到提交与取消；其余行为 null。 */
  const renameFor = (id: string, commit: (value: string) => void): RenameHandlers | null =>
    renamingId === id
      ? {
          onRename: (value) => {
            setRenamingId(null)
            commit(value)
          },
          onCancel: () => setRenamingId(null),
        }
      : null

  const threadActions = (thread: Thread): RowAction[] =>
    onRenameThread && onArchiveThread
      ? threadMenu(thread, {
          t,
          status: threadStatus[thread.id] ?? thread.status ?? "idle",
          active: thread.id === activeThreadId,
          rename: () => setRenamingId(thread.id),
          archive: () => onArchiveThread(thread.id),
          unarchive: onUnarchiveThread && (() => onUnarchiveThread(thread.id)),
          markRead: onMarkThreadRead && ((read) => onMarkThreadRead(thread.id, read)),
          reference: onReferenceThread && (() => onReferenceThread(thread)),
        })
      : []

  const projectActions = (project: Project): RowAction[] => {
    const index = projectIds.indexOf(project.id)
    const manageable = onRenameProject !== undefined && onRemoveProject !== undefined
    return projectMenu({
      t,
      previous: projectIds[index - 1],
      next: projectIds[index + 1],
      browse: onBrowseFiles && (() => onBrowseFiles(project.id)),
      reveal: () => void openFolder(project.rootPath).catch(() => openFailed(project.rootPath)),
      rename: manageable ? () => setRenamingId(project.id) : undefined,
      move: (target, place) => reorder(project.id, target, place),
      remove: manageable
        ? () => {
            onRemoveProject?.(project.id)
            toast(t("sidebar.projectRemoved").replace("{name}", project.name))
          }
        : undefined,
    })
  }

  const row = (thread: Thread) => {
    const index = shortcutHints ? shortcutIndex.get(thread.id) : undefined
    const agentId = thread.lastAgentId ?? thread.defaultAgentId
    const instanceId = thread.lastInstanceId ?? agentId
    const agentName = agentNames[instanceId] ?? instanceId
    const projectName = projectNames.get(thread.projectId)
    return (
      <ThreadRow
        key={thread.id}
        thread={thread}
        active={thread.id === activeThreadId}
        status={threadStatus[thread.id] ?? thread.status ?? "idle"}
        // 图标只是装饰；读屏器读 agent 的全名，悬停时也显示全名。
        detail={
          <span className="sess-agent" title={agentName}>
            <AgentIcon agentId={agentId} instanceId={instanceId} name={agentName} size="sm" />
            <span className="sr-only">{agentName}</span>
          </span>
        }
        description={
          grouping !== "project" && view.showProject && projectName ? (
            <span className="truncate">{projectName}</span>
          ) : undefined
        }
        showTime={view.showTime}
        shortcut={index ? formatShortcut(`Mod+${index}`) : null}
        rename={renameFor(thread.id, (title) => onRenameThread?.(thread.id, title))}
        actions={threadActions(thread)}
        onOpen={() => onOpenThread(thread.id)}
        now={now}
      />
    )
  }

  const sectionLabel = (section: SidebarSection) =>
    section.kind === "project"
      ? section.project.name
      : t(
          (section.kind === "time"
            ? `sidebar.bucket.${section.key}`
            : `sidebar.status.${section.key}`) as MessageKey,
        )
  const first = sections[0]

  /**
   * 列表最上面的标题行，带「自定义侧栏」和「添加项目」；不按项目分组时它就是第一段的标题。
   * 总在同一个位置渲染：换分组时菜单不会因为按钮挪了地方被卸载、关掉。
   */
  const header = (label: string) => (
    <div className="side-label">
      <span>{label}</span>
      <div className="side-label-actions" data-spread={view.showTime ? "" : undefined}>
        <SidebarMenu
          grouping={grouping}
          view={view}
          unread={threads.some((thread) => thread.unread)}
          onGrouping={setGrouping}
          onView={setView}
          onMarkAllRead={onMarkAllRead}
        />
        <Button
          variant="plain"
          className="icon-btn"
          type="button"
          aria-label={t("nav.addProject")}
          title={t("nav.addProject")}
          onClick={onAddProject}
        >
          <Icon name="sidebar-add-project" />
        </Button>
      </div>
    </div>
  )

  const filtering = filtersActive(view)
  const emptyNote: MessageKey | null =
    projects.length > 0 && sections.length === 0
      ? view.archived
        ? "sidebar.noArchived"
        : filtering
          ? "sidebar.noMatches"
          : "sidebar.noThreads"
      : null

  /** 项目块接住拖过来的项目：上半截放前面，下半截放后面；拖进来的文件、文字不理会。 */
  const dropTarget = (projectId: string) => ({
    "data-drop": drop?.id === projectId ? drop.place : undefined,
    "data-dragging": dragging === projectId ? "" : undefined,
    onDragOver: (event: DragEvent<HTMLDivElement>) => {
      if (!event.dataTransfer.types.includes(PROJECT_DRAG_TYPE)) return
      event.preventDefault()
      event.dataTransfer.dropEffect = "move"
      const place = dropPlace(event)
      if (drop?.id !== projectId || drop.place !== place) setDrop({ id: projectId, place })
    },
    onDragLeave: (event: DragEvent<HTMLDivElement>) => {
      if (event.currentTarget.contains(event.relatedTarget as Node | null)) return
      setDrop((current) => (current?.id === projectId ? null : current))
    },
    onDrop: (event: DragEvent<HTMLDivElement>) => {
      const id = event.dataTransfer.getData(PROJECT_DRAG_TYPE)
      if (!id) return
      event.preventDefault()
      reorder(id, projectId, dropPlace(event))
      setDrop(null)
      setDragging(null)
    },
  })

  return (
    <>
      <div className="side-head">
        <nav className="side-actions" aria-label={t("nav.projects")}>
          <ListRow
            render={<button type="button" />}
            className="nav-item new-thread-btn"
            aria-label={t("nav.newThread")}
            onClick={() => onNewThread()}
            leading={<Icon name="compose" />}
            title={t("nav.newThread")}
            meta={<kbd className="nav-kbd">{formatShortcut("Mod+n")}</kbd>}
          />
          {onOpenSchedules ? (
            <ListRow
              render={<button type="button" />}
              className="nav-item"
              selected={activeNav === "schedules"}
              aria-current={activeNav === "schedules" ? "page" : undefined}
              onClick={onOpenSchedules}
              leading={<Icon name="clock" />}
              title={t("settings.schedules")}
            />
          ) : null}
          {onOpenPlugins ? (
            <ListRow
              render={<button type="button" />}
              className="nav-item"
              selected={activeNav === "plugins"}
              aria-current={activeNav === "plugins" ? "page" : undefined}
              onClick={onOpenPlugins}
              leading={<Icon name="cube" />}
              title={t("settings.plugins")}
            />
          ) : null}
        </nav>
      </div>
      <SideScroll>
        {header(
          grouping === "project"
            ? t("nav.projects")
            : first
              ? sectionLabel(first)
              : t("sidebar.threads"),
        )}
        {projects.length === 0 ? (
          <ListRow
            render={<button type="button" />}
            className="nav-item side-add-project"
            onClick={onAddProject}
            leading={<Icon name="plus" />}
            title={t("nav.addProject")}
          />
        ) : null}
        {emptyNote ? (
          <div className="recent-sessions">
            <EmptyState size="compact" title={t(emptyNote)} />
          </div>
        ) : null}
        {sections.map((section, index) => {
          if (section.kind === "project") {
            const { project, open } = section
            return (
              <div key={project.id} className="proj-block" {...dropTarget(project.id)}>
                <ProjectRow
                  project={project}
                  open={open}
                  rename={renameFor(project.id, (name) => onRenameProject?.(project.id, name))}
                  actions={projectActions(project)}
                  onToggle={() => onToggleProject(project.id, !open)}
                  onNewThread={() => onNewThread(project.id)}
                  onDragStart={projects.length > 1 ? () => setDragging(project.id) : undefined}
                  onDragEnd={() => {
                    setDragging(null)
                    setDrop(null)
                  }}
                />
                {open ? (
                  <div className="proj-sessions">
                    {section.threads.length === 0 ? (
                      <EmptyState size="compact" title={t("sidebar.noThreads")} />
                    ) : null}
                    {section.threads.map(row)}
                  </div>
                ) : null}
              </div>
            )
          }
          const label = sectionLabel(section)
          return (
            <div key={section.key} className="recent-sessions" role="group" aria-label={label}>
              {index > 0 ? (
                <div className="side-label">
                  <span>{label}</span>
                </div>
              ) : null}
              {section.threads.map(row)}
            </div>
          )
        })}
        {children}
      </SideScroll>
    </>
  )
}
