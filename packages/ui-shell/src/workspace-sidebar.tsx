/** 工作区侧栏：项目树、线程列表与设置入口。 */
import type { Project, Thread } from "@pigcode/contracts"
import { Button, useLocale } from "@pigcode/ui-primitives"
import { Icon } from "./icon"
import type { ThreadTabStatus } from "./thread-tabs"

/** 工作区侧栏所需的数据与事件；数据由 store 传入。 */
export interface WorkspaceSidebarProps {
  projects: Project[]
  threads: Thread[]
  activeThreadId: string | null
  threadStatus?: Record<string, ThreadTabStatus> | undefined
  expandedProjects: Record<string, boolean>
  onAddProject: () => void
  onToggleProject: (projectId: string, expanded: boolean) => void
  onOpenThread: (threadId: string) => void
  onNewThread: (projectId?: string) => void
  onOpenSettings?: () => void
  /** 搜索尚未接入时可以不传，侧栏不渲染搜索入口。 */
  onSearch?: () => void
}

/** 把 provider id 缩成侧栏可读的短标记。 */
function providerMark(thread: Thread): string {
  const id = thread.lastProviderId ?? thread.defaultProviderId
  if (id === "claude") return "CL"
  if (id === "codex") return "CX"
  return id.slice(0, 2).toUpperCase()
}

/** 把线程更新时间格式化成“刚刚 / 3 分钟前 / 昨天”的短文本。 */
function formatThreadTime(value: string, locale: string): string {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return ""
  const diff = Date.now() - date.getTime()
  const minutes = Math.floor(diff / 60_000)
  if (minutes < 1) return locale.startsWith("zh") ? "刚刚" : "now"
  if (minutes < 60) return locale.startsWith("zh") ? `${minutes} 分钟前` : `${minutes}m`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return locale.startsWith("zh") ? `${hours} 小时前` : `${hours}h`
  const days = Math.floor(hours / 24)
  if (days < 7) return locale.startsWith("zh") ? `${days} 天前` : `${days}d`
  return new Intl.DateTimeFormat(locale, { month: "short", day: "numeric" }).format(date)
}

/** 绘制工作区导航，不读取会话内核。 */
export function WorkspaceSidebar({
  projects,
  threads,
  activeThreadId,
  threadStatus = {},
  expandedProjects,
  onAddProject,
  onToggleProject,
  onOpenThread,
  onNewThread,
  onSearch,
}: WorkspaceSidebarProps) {
  const { t, locale } = useLocale()
  return (
    <>
      <nav className="side-actions" aria-label={t("nav.projects")}>
        <Button
          variant="primary"
          className="new-thread-btn"
          type="button"
          aria-label={t("nav.newThread")}
          onClick={() => onNewThread()}
        >
          <Icon name="plus" />
          <span className="grow">{t("nav.newThread")}</span>
          <span className="new-thread-kbd">⌘N</span>
        </Button>
        {onSearch ? (
          <Button variant="plain" className="side-command" type="button" onClick={onSearch}
            aria-label={t("nav.search")}
          >
            <Icon name="search" />
            <span className="grow">{t("nav.search")}</span>
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
        <div className="side-empty-card">
          <span className="side-empty-icon">
            <Icon name="folder" />
          </span>
          <strong>{t("nav.addProject")}</strong>
          <p>{t("chat.empty.hint")}</p>
          <Button variant="primary" size="sm" type="button" onClick={onAddProject}>
            {t("nav.addProject")}
          </Button>
        </div>
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
                {projectThreads.length > 0 ? (
                  <span className="proj-count">{projectThreads.length}</span>
                ) : null}
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
                  const status = threadStatus[thread.id] ?? "idle"
                  return (
                    <Button
                      variant="plain"
                      key={thread.id}
                      className={active ? "sess is-active" : "sess"}
                      type="button"
                      aria-current={active ? "page" : undefined}
                      data-status={status}
                      onClick={() => onOpenThread(thread.id)}
                    >
                      <span className="sess-dot" data-status={status} />
                      <span className="sess-provider">{providerMark(thread)}</span>
                      <span className="sess-title truncate">{thread.title}</span>
                      <time>{formatThreadTime(thread.updatedAt, locale)}</time>
                    </Button>
                  )
                })}
              </div>
            ) : null}
          </div>
        )
      })}
    </>
  )
}
