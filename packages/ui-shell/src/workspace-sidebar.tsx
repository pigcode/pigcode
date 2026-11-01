/** 工作区侧栏：主导航、项目与会话列表；会话可按项目分组或按时间排成一列。 */
import { useEffect, useState, type ReactNode } from "react"
import type { Project, Thread } from "@pigcode/contracts"
import {
  Button,
  EmptyState,
  EntityAvatar,
  ListRow,
  Menu,
  formatShortcut,
  useLocale,
  useSidebarGrouping,
  type SidebarGrouping,
} from "@pigcode/ui-primitives"
import { Icon } from "./icon"
import { openFolder, revealLabelKey, useOpenFailure } from "./open-in"
import { ProjectRow, ThreadRow, type RenameHandlers, type RowAction } from "./sidebar-rows"
import type { ThreadStatus } from "./thread-status"
import { useToast } from "./toast"

/** 工作区侧栏所需的数据与事件；数据由 store 传入。 */
export interface WorkspaceSidebarProps {
  projects: Project[]
  threads: Thread[]
  activeThreadId: string | null
  threadStatus?: Record<string, ThreadStatus> | undefined
  /** agent 的显示名，按 provider id；会话行上的 agent 缩写由它得出，缺少时用 id。 */
  agentNames?: Readonly<Record<string, string>> | undefined
  expandedProjects: Record<string, boolean>
  onAddProject: () => void
  onToggleProject: (projectId: string, expanded: boolean) => void
  onOpenThread: (threadId: string) => void
  onNewThread: (projectId?: string) => void
  onOpenSettings?: () => void
  /** 定时任务入口；不传时不显示。 */
  onOpenSchedules?: () => void
  /** 插件入口；不传时不显示。 */
  onOpenPlugins?: () => void
  /** 会话行右键菜单里的重命名与归档；两个都传时才有菜单。 */
  onRenameThread?: ((threadId: string, title: string) => void) | undefined
  onArchiveThread?: ((threadId: string) => void) | undefined
  /** 项目行右键菜单里的重命名与移除；两个都传时才有菜单，菜单里另有「在文件管理器中打开」。 */
  onRenameProject?: ((projectId: string, name: string) => void) | undefined
  onRemoveProject?: ((projectId: string) => void) | undefined
  /** 按住 ⌘/Ctrl 时在前九个会话上显示数字快捷键。 */
  shortcutHints?: boolean
}

/** 侧栏里从上到下可见的会话；⌘/Ctrl+数字按这个顺序跳转。 */
export function visibleThreads(
  projects: readonly Project[],
  threads: readonly Thread[],
  grouping: SidebarGrouping,
  expandedProjects: Record<string, boolean>,
): Thread[] {
  const known = new Set(projects.map((project) => project.id))
  const live = threads.filter((thread) => thread.archivedAt === null && known.has(thread.projectId))
  if (grouping === "time") {
    return [...live].sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
  }
  return projects.flatMap((project) =>
    (expandedProjects[project.id] ?? true)
      ? live.filter((thread) => thread.projectId === project.id)
      : [],
  )
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

/** 「项目」标题旁的排列方式菜单。 */
function GroupingMenu({
  value,
  onChange,
}: {
  value: SidebarGrouping
  onChange: (value: SidebarGrouping) => void
}) {
  const { t } = useLocale()
  const options: Array<{ id: SidebarGrouping; label: string }> = [
    { id: "project", label: t("settings.general.byProject") },
    { id: "time", label: t("settings.general.byTime") },
  ]
  return (
    <Menu.Root>
      <Menu.Trigger
        className="icon-btn"
        type="button"
        aria-label={t("sidebar.grouping")}
        title={t("sidebar.grouping")}
      >
        <Icon name="filter" small />
      </Menu.Trigger>
      <Menu.Portal>
        <Menu.Positioner side="bottom" align="end" sideOffset={6}>
          <Menu.Popup>
            {options.map((option) => (
              <Menu.Item key={option.id} onClick={() => onChange(option.id)}>
                <span className="grow">{option.label}</span>
                {option.id === value ? <Icon name="check" small className="check-mark" /> : null}
              </Menu.Item>
            ))}
          </Menu.Popup>
        </Menu.Positioner>
      </Menu.Portal>
    </Menu.Root>
  )
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
  onOpenSchedules,
  onOpenPlugins,
  onRenameThread,
  onArchiveThread,
  onRenameProject,
  onRemoveProject,
  shortcutHints = false,
}: WorkspaceSidebarProps) {
  const { t } = useLocale()
  const toast = useToast()
  const openFailed = useOpenFailure()
  const [grouping, setGrouping] = useSidebarGrouping()
  const now = useMinuteClock()
  // 同一时间只有一行在改名；项目与会话的 id 前缀不同，不会撞上。
  const [renamingId, setRenamingId] = useState<string | null>(null)
  const projectNames = new Map(projects.map((project) => [project.id, project.name]))
  const liveThreads = threads.filter(
    (thread) => thread.archivedAt === null && projectNames.has(thread.projectId),
  )
  const order = visibleThreads(projects, threads, grouping, expandedProjects)
  const shortcutIndex = new Map(order.slice(0, 9).map((thread, index) => [thread.id, index + 1]))

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
      ? [
          { icon: "pencil", label: t("sidebar.rename"), run: () => setRenamingId(thread.id) },
          { icon: "archive", label: t("sidebar.archive"), run: () => onArchiveThread(thread.id) },
        ]
      : []

  const projectActions = (project: Project): RowAction[] =>
    onRenameProject && onRemoveProject
      ? [
          { icon: "pencil", label: t("sidebar.rename"), run: () => setRenamingId(project.id) },
          {
            icon: "folder-open",
            label: t(revealLabelKey()),
            run: () => void openFolder(project.rootPath).catch(() => openFailed(project.rootPath)),
          },
          {
            icon: "x",
            label: t("sidebar.removeProject"),
            separated: true,
            run: () => {
              onRemoveProject(project.id)
              toast(t("sidebar.projectRemoved").replace("{name}", project.name))
            },
          },
        ]
      : []

  const row = (thread: Thread, detail: ReactNode) => {
    const index = shortcutHints ? shortcutIndex.get(thread.id) : undefined
    return (
      <ThreadRow
        key={thread.id}
        thread={thread}
        active={thread.id === activeThreadId}
        status={threadStatus[thread.id] ?? "idle"}
        detail={detail}
        shortcut={index ? formatShortcut(`Mod+${index}`) : null}
        rename={renameFor(thread.id, (title) => onRenameThread?.(thread.id, title))}
        actions={threadActions(thread)}
        onOpen={() => onOpenThread(thread.id)}
        now={now}
      />
    )
  }

  return (
    <>
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
            onClick={onOpenSchedules}
            leading={<Icon name="clock" />}
            title={t("settings.schedules")}
          />
        ) : null}
        {onOpenPlugins ? (
          <ListRow
            render={<button type="button" />}
            className="nav-item"
            onClick={onOpenPlugins}
            leading={<Icon name="cube" />}
            title={t("settings.plugins")}
          />
        ) : null}
      </nav>
      <div className="side-label">
        <span>{grouping === "time" ? t("sidebar.recent") : t("nav.projects")}</span>
        <GroupingMenu value={grouping} onChange={setGrouping} />
        <Button
          variant="plain"
          className="icon-btn"
          type="button"
          aria-label={t("nav.addProject")}
          title={t("nav.addProject")}
          onClick={onAddProject}
        >
          <Icon name="folder-plus" small />
        </Button>
      </div>
      {projects.length === 0 ? (
        <ListRow
          render={<button type="button" />}
          className="nav-item side-add-project"
          onClick={onAddProject}
          leading={<Icon name="plus" />}
          title={t("nav.addProject")}
        />
      ) : null}
      {grouping === "time" ? (
        <div className="recent-sessions">
          {projects.length > 0 && liveThreads.length === 0 ? (
            <EmptyState size="compact" title={t("sidebar.noThreads")} />
          ) : null}
          {order.map((thread) =>
            row(
              thread,
              <span className="sess-project truncate">
                {projectNames.get(thread.projectId) ?? ""}
              </span>,
            ),
          )}
        </div>
      ) : (
        projects.map((project) => {
          const open = expandedProjects[project.id] ?? true
          const projectThreads = liveThreads.filter((thread) => thread.projectId === project.id)
          return (
            <div key={project.id} className="proj-block">
              <ProjectRow
                project={project}
                open={open}
                rename={renameFor(project.id, (name) => onRenameProject?.(project.id, name))}
                actions={projectActions(project)}
                onToggle={() => onToggleProject(project.id, !open)}
                onNewThread={() => onNewThread(project.id)}
              />
              {open ? (
                <div className="proj-sessions">
                  {projectThreads.length === 0 ? (
                    <EmptyState size="compact" title={t("sidebar.noThreads")} />
                  ) : null}
                  {projectThreads.map((thread) => {
                    const providerId = thread.lastProviderId ?? thread.defaultProviderId
                    const agentName = agentNames[providerId] ?? providerId
                    // 缩写只是装饰；读屏器读 agent 的全名。
                    return row(
                      thread,
                      <>
                        <EntityAvatar
                          id={providerId}
                          name={agentName}
                          size="inline"
                          className="sess-provider"
                        />
                        <span className="sr-only">{agentName}</span>
                      </>,
                    )
                  })}
                </div>
              ) : null}
            </div>
          )
        })
      )}
    </>
  )
}
