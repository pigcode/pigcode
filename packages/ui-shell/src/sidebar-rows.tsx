/** 侧栏里的项目行与会话行：右键菜单、就地改名，会话行还有状态点、时间与数字快捷键。 */
import { Fragment, useRef, type ReactNode } from "react"
import type { Project, Thread } from "@pigcode/contracts"
import {
  Button,
  ContextMenu,
  ListRow,
  StatusDot,
  formatRelativeTime,
  useLocale,
} from "@pigcode/ui-primitives"
import { Icon } from "./icon"
import { THREAD_STATUS_MESSAGE, THREAD_STATUS_TONE, type ThreadStatus } from "./thread-status"

/** 右键菜单里的一项；separated 时在它上方画分隔线。 */
export interface RowAction {
  icon: string
  label: string
  run: () => void
  separated?: boolean
}

/** 改名中的行：提交新名字或放弃。 */
export interface RenameHandlers {
  onRename: (value: string) => void
  onCancel: () => void
}

/** 给一行加上右键菜单；没有动作时原样返回。 */
function RowMenu({ actions, children }: { actions: RowAction[]; children: ReactNode }) {
  if (actions.length === 0) return children
  return (
    <ContextMenu.Root>
      <ContextMenu.Trigger className="row-menu-area">{children}</ContextMenu.Trigger>
      <ContextMenu.Portal>
        <ContextMenu.Positioner>
          {/* 菜单关闭后不把焦点还给行，否则会抢走「重命名」刚聚焦的输入框 */}
          <ContextMenu.Popup finalFocus={false}>
            {actions.map((action) => (
              <Fragment key={action.label}>
                {action.separated ? <ContextMenu.Separator /> : null}
                <ContextMenu.Item onClick={action.run}>
                  <Icon name={action.icon} small />
                  <span className="grow">{action.label}</span>
                </ContextMenu.Item>
              </Fragment>
            ))}
          </ContextMenu.Popup>
        </ContextMenu.Positioner>
      </ContextMenu.Portal>
    </ContextMenu.Root>
  )
}

/** 改名输入框：回车或失焦提交，Esc 取消；没有改动或清空时等同取消。 */
function RenameInput({
  value,
  label,
  onRename,
  onCancel,
}: { value: string; label: string } & RenameHandlers) {
  const done = useRef(false)
  function finish(next: string | null): void {
    if (done.current) return
    done.current = true
    const trimmed = next?.trim() ?? ""
    if (trimmed && trimmed !== value) onRename(trimmed)
    else onCancel()
  }
  return (
    <input
      className="row-rename"
      defaultValue={value}
      autoFocus
      maxLength={120}
      aria-label={label}
      onFocus={(event) => event.currentTarget.select()}
      onKeyDown={(event) => {
        if (event.key === "Enter") {
          event.preventDefault()
          finish(event.currentTarget.value)
        } else if (event.key === "Escape") {
          event.preventDefault()
          finish(null)
        }
      }}
      onBlur={(event) => finish(event.currentTarget.value)}
    />
  )
}

/** 会话的状态标记：运行中是游走的点阵（.sess-indicator），其余状态是一个彩色圆点（.sess-dot）。 */
export function ThreadStatusMark({ status }: { status: ThreadStatus }) {
  return (
    <StatusDot
      tone={THREAD_STATUS_TONE[status]}
      className={status === "running" ? "sess-indicator" : "sess-dot"}
      data-status={status}
    />
  )
}

/** 一行会话：状态点、标题、补充信息（agent 缩写或项目名）与时间；按住 ⌘/Ctrl 时时间换成快捷键。 */
export function ThreadRow({
  thread,
  active,
  status,
  detail,
  shortcut,
  rename,
  actions,
  onOpen,
  now,
}: {
  thread: Thread
  active: boolean
  status: ThreadStatus
  detail: ReactNode
  shortcut: string | null
  /** 改名中时传入；行换成输入框。 */
  rename: RenameHandlers | null
  actions: RowAction[]
  onOpen: () => void
  /** 计算相对时间用的当前时间；侧栏每分钟刷新一次。 */
  now?: number
}) {
  const { t, locale } = useLocale()
  const statusKey = THREAD_STATUS_MESSAGE[status]
  if (rename) {
    return (
      <ListRow
        className="sess is-editing"
        data-status={status}
        selected
        leading={<ThreadStatusMark status={status} />}
        title={<RenameInput value={thread.title} label={t("sidebar.threadName")} {...rename} />}
      />
    )
  }
  return (
    <RowMenu actions={actions}>
      <ListRow
        render={<button type="button" />}
        className={active ? "sess is-active" : "sess"}
        selected={active}
        aria-current={active ? "page" : undefined}
        data-status={status}
        onClick={onOpen}
        leading={
          <>
            <ThreadStatusMark status={status} />
            {statusKey ? <span className="sr-only">{t(statusKey)}</span> : null}
          </>
        }
        title={thread.title}
        titleProps={{ className: "sess-title", title: thread.title }}
        meta={
          shortcut ? (
            <kbd className="sess-kbd">{shortcut}</kbd>
          ) : (
            <>
              {detail}
              <time dateTime={thread.updatedAt}>
                {formatRelativeTime(thread.updatedAt, locale, now)}
              </time>
            </>
          )
        }
      />
    </RowMenu>
  )
}

/** 项目行：文件夹图标与名字，点击折叠或展开；悬停时右侧出现新会话按钮。 */
export function ProjectRow({
  project,
  open,
  rename,
  actions,
  onToggle,
  onNewThread,
}: {
  project: Project
  open: boolean
  rename: RenameHandlers | null
  actions: RowAction[]
  onToggle: () => void
  onNewThread: () => void
}) {
  const { t } = useLocale()
  const folder = <Icon name={open ? "folder-open" : "folder"} className="proj-folder" />
  if (rename) {
    return (
      <ListRow
        className="proj-row is-editing"
        selected
        leading={folder}
        title={<RenameInput value={project.name} label={t("sidebar.projectName")} {...rename} />}
      />
    )
  }
  return (
    <RowMenu actions={actions}>
      <ListRow
        className="proj-row"
        button={{ className: "proj", "aria-expanded": open, onClick: onToggle }}
        leading={folder}
        title={project.name}
        actions={
          <Button
            variant="plain"
            className="icon-btn proj-add"
            type="button"
            aria-label={t("nav.newThread")}
            title={t("nav.newThread")}
            onClick={onNewThread}
          >
            <Icon name="plus" small />
          </Button>
        }
      />
    </RowMenu>
  )
}
