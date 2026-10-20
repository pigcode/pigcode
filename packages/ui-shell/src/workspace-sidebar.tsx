/** 工作区侧栏：项目树、线程列表与设置入口。 */
import type { Project, Thread } from "@pigcode/contracts"
import { Button, useLocale } from "@pigcode/ui-primitives"
import { Icon } from "./icon"

/** 工作区侧栏所需的数据与事件；数据由 store 传入。 */
export interface WorkspaceSidebarProps {
  projects: Project[]
  threads: Thread[]
  activeThreadId: string | null
  expandedProjects: Record<string, boolean>
  onAddProject: () => void
  onToggleProject: (projectId: string, expanded: boolean) => void
  onOpenThread: (threadId: string) => void
  onNewThread: (projectId?: string) => void
  onOpenSettings: () => void
  /** 搜索尚未接入时可以不传，侧栏不渲染搜索入口。 */
  onSearch?: () => void
}

/** 把线程更新时间格式化成侧栏可读的短文本。 */
function formatThreadTime(value: string, locale: string): string {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return ""
  return new Intl.DateTimeFormat(locale, { month: "short", day: "numeric" }).format(date)
}

/** 绘制工作区导航，不读取会话内核。 */
export function WorkspaceSidebar({
  projects,
  threads,
  activeThreadId,
  expandedProjects,
  onAddProject,
  onToggleProject,
  onOpenThread,
  onNewThread,
  onOpenSettings,
  onSearch,
}: WorkspaceSidebarProps) {
  const { t, locale } = useLocale()
  return (
    <>
      <nav aria-label={t("nav.projects")}>
        <Button variant="plain" className="nav-item" type="button" onClick={() => onNewThread()}>
          <Icon name="pencil" />
          {t("nav.newThread")}
          <span className="nav-kbd">⌘N</span>
        </Button>
        {onSearch ? (
          <Button variant="plain" className="nav-item" type="button" onClick={onSearch}>
            <Icon name="search" />
            {t("nav.search")}
            <span className="nav-kbd">⌘K</span>
          </Button>
        ) : null}
      </nav>
      <div className="side-label">
        <span>{t("nav.projects")}</span>
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
        <Button
          variant="plain"
          className="nav-item muted-item"
          type="button"
          onClick={onAddProject}
        >
          <Icon name="plus" />
          {t("nav.addProject")}
        </Button>
      ) : null}
      {projects.map((project) => {
        const open = expandedProjects[project.id] ?? true
        const projectThreads = threads.filter(
          (thread) => thread.projectId === project.id && thread.archivedAt === null,
        )
        return (
          <div key={project.id} className="proj-block">
            <div className="proj-row">
              <Button
                variant="plain"
                className="proj"
                type="button"
                aria-expanded={open}
                onClick={() => onToggleProject(project.id, !open)}
              >
                <span className="proj-icon">
                  <Icon name="folder" className="proj-folder" />
                  <Icon name={open ? "down" : "right"} small className="proj-caret" />
                </span>
                <span className="truncate">{project.name}</span>
              </Button>
              <Button
                variant="plain"
                className="icon-btn proj-add"
                type="button"
                aria-label={t("nav.newThread")}
                title={t("nav.newThread")}
                onClick={() => onNewThread(project.id)}
              >
                <Icon name="plus" small />
              </Button>
            </div>
            {open ? (
              <div className="proj-sessions">
                {projectThreads.length === 0 ? (
                  <p className="side-empty">{t("sidebar.noThreads")}</p>
                ) : null}
                {projectThreads.map((thread) => {
                  const active = thread.id === activeThreadId
                  return (
                    <Button
                      variant="plain"
                      key={thread.id}
                      className={active ? "sess is-active" : "sess"}
                      type="button"
                      aria-current={active ? "page" : undefined}
                      onClick={() => onOpenThread(thread.id)}
                    >
                      <span className="sess-dot" />
                      <span className="truncate">{thread.title}</span>
                      <time>{formatThreadTime(thread.updatedAt, locale)}</time>
                    </Button>
                  )
                })}
              </div>
            ) : null}
          </div>
        )
      })}
      <Button variant="plain" className="nav-item" type="button" onClick={onOpenSettings}>
        <Icon name="gear" />
        {t("settings.title")}
      </Button>
    </>
  )
}
