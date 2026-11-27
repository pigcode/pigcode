/** 工作区侧栏的多主机布局模式切换、拖拽判定与分组展示组件。 */
import type { DragEvent, ReactNode } from "react"
import type { HostSummary, Project, Thread } from "@pigcode/contracts"
import {
  Button,
  HostDot,
  ListRow,
  formatShortcut,
  hostDisplayName,
  useLocale,
} from "@pigcode/ui-primitives"
import type { SidebarGrouping, SidebarView } from "@pigcode/ui-primitives"
import { Icon } from "./icon"
import { sidebarSections, type SidebarSection } from "./sidebar-arrangement"
import { PROJECT_DRAG_TYPE } from "./sidebar-rows"
import type { ThreadStatus } from "./thread-status"

/** 拖到项目的上半截放在它前面，下半截放在它后面。 */
export function dropPlace(event: DragEvent<HTMLElement>): "before" | "after" {
  const box = event.currentTarget.getBoundingClientRect()
  return event.clientY > box.top + box.height / 2 ? "after" : "before"
}

export interface ProjectDropState {
  id: string
  place: "before" | "after"
}

/** 生成项目行拖拽放置所需的 DOM 属性与处理器。 */
export function projectDropTargetProps(
  projectId: string,
  drop: ProjectDropState | null,
  dragging: string | null,
  setDrop: (
    next: ProjectDropState | null | ((cur: ProjectDropState | null) => ProjectDropState | null),
  ) => void,
  setDragging: (next: string | null) => void,
  reorder: (id: string, targetId: string, place: "before" | "after") => void,
) {
  return {
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
  }
}

export type HostLayoutMode = "mixed" | "host"
const HOST_LAYOUT_KEY = "pigcode.hostLayout"

export function readHostLayout(): HostLayoutMode {
  try {
    return window.localStorage.getItem(HOST_LAYOUT_KEY) === "host" ? "host" : "mixed"
  } catch {
    return "mixed"
  }
}

export function saveHostLayout(mode: HostLayoutMode): void {
  try {
    window.localStorage.setItem(HOST_LAYOUT_KEY, mode)
  } catch {
    // 隐私模式或无存储权限时不阻断切换
  }
}

/** 工作区侧栏顶部固定导航：只保留新会话与定时任务。 */
export function WorkspaceSidebarHead({
  activeNav,
  onNewThread,
  onOpenSchedules,
}: {
  activeNav?: "schedules" | undefined
  onNewThread: () => void
  onOpenSchedules?: (() => void) | undefined
}) {
  const { t } = useLocale()
  return (
    <div className="side-head">
      <nav className="side-actions" aria-label={t("nav.projects")}>
        <ListRow
          render={<button type="button" />}
          className="nav-item new-thread-btn"
          aria-label={t("nav.newThread")}
          onClick={onNewThread}
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
      </nav>
    </div>
  )
}

/** 标题栏右侧的「混排 / 按主机」视图切换控件。 */
export function WorkspaceHostSwitch({
  hostLayout,
  onChange,
}: {
  hostLayout: HostLayoutMode
  onChange: (mode: HostLayoutMode) => void
}) {
  const { t } = useLocale()
  return (
    <div className="side-host-switch" role="group" aria-label={t("hosts.sidebarMode")}>
      <button
        type="button"
        className="side-host-switch-btn"
        aria-pressed={hostLayout === "mixed"}
        onClick={() => onChange("mixed")}
      >
        {t("hosts.viewMixed")}
      </button>
      <button
        type="button"
        className="side-host-switch-btn"
        aria-pressed={hostLayout === "host"}
        onClick={() => onChange("host")}
      >
        {t("hosts.viewByHost")}
      </button>
    </div>
  )
}

/** 按主机分组展示的项目与会话列表（切换为「按主机」模式时使用）。 */
export function WorkspaceHostGroups({
  hosts,
  projects,
  threads,
  hostOfProject,
  hostOfThread,
  grouping,
  view,
  threadStatus,
  expandedProjects,
  heldThreadId,
  now,
  onAddProjectOnHost,
  renderSectionList,
}: {
  hosts: readonly HostSummary[]
  projects: readonly Project[]
  threads: readonly Thread[]
  hostOfProject?: Readonly<Record<string, HostSummary>> | undefined
  hostOfThread?: Readonly<Record<string, HostSummary>> | undefined
  grouping: SidebarGrouping
  view: SidebarView
  threadStatus: Record<string, ThreadStatus>
  expandedProjects: Record<string, boolean>
  heldThreadId?: string | null | undefined
  now: number
  onAddProjectOnHost?: ((hostId: string) => void) | undefined
  renderSectionList: (
    sections: SidebarSection[],
    pinned: Set<string>,
    skipFirstGroupLabel: boolean,
  ) => ReactNode
}) {
  const { t } = useLocale()
  return (
    <>
      {hosts.map((host) => {
        const hProjects = projects.filter((p) => hostOfProject?.[p.id]?.id === host.id)
        const hThreads = threads.filter((tr) => hostOfThread?.[tr.id]?.id === host.id)
        const hSections = sidebarSections(hProjects, hThreads, {
          grouping,
          view,
          status: threadStatus,
          expandedProjects,
          heldThreadId,
          now,
        })
        const hFirst = hSections[0]
        const hPinned = new Set(
          hFirst?.kind === "pinned" ? hFirst.threads.map((tr) => tr.projectId) : [],
        )
        const offline = host.status !== "connected"
        const displayName = hostDisplayName(host, t("hosts.localTag"))
        return (
          <div key={host.id} className="host-group-block">
            <div className="side-host-group">
              <HostDot color={host.badgeColor} offline={offline} />
              <span className="truncate">{displayName}</span>
              {offline ? (
                <span className="side-host-group-meta">{t("hosts.offlineBadge")}</span>
              ) : null}
              <span className="side-host-group-spacer" />
              {!offline && onAddProjectOnHost ? (
                <Button
                  variant="plain"
                  className="icon-btn"
                  type="button"
                  aria-label={`${t("nav.addProject")} (${displayName})`}
                  title={t("nav.addProject")}
                  onClick={() => onAddProjectOnHost(host.id)}
                >
                  <Icon name="plus" small />
                </Button>
              ) : null}
            </div>
            {renderSectionList(hSections, hPinned, false)}
          </div>
        )
      })}
    </>
  )
}
