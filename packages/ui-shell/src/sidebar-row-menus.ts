/**
 * 侧栏右键菜单里有什么。会话可重命名、置顶、标读、引用、归档或恢复。
 * 项目照 Cursor 的项目菜单：先打开（查看文件、在文件管理器中打开），再重命名，然后挪动，最后从侧栏移除。
 */
import type { Thread } from "@pigcode/contracts"
import type { MessageKey } from "@pigcode/ui-primitives"
import { revealLabelKey } from "./open-in"
import type { RowAction } from "./sidebar-rows"
import type { ThreadStatus } from "./thread-status"

type Translate = (key: MessageKey) => string

const FINISHED = new Set<ThreadStatus>(["completed", "failed", "interrupted"])

/** 会话行的菜单；没给的操作不出现。 */
export function threadMenu(
  thread: Thread,
  {
    t,
    status,
    active,
    rename,
    setPinned,
    archive,
    unarchive,
    markRead,
    reference,
  }: {
    t: Translate
    status: ThreadStatus
    /** 正在看的会话：引用自己没有意义，标未读也马上会变回已读。 */
    active: boolean
    rename: () => void
    setPinned?: ((pinned: boolean) => void) | undefined
    archive: () => void
    unarchive?: (() => void) | undefined
    markRead?: ((read: boolean) => void) | undefined
    reference?: (() => void) | undefined
  },
): RowAction[] {
  const unread = thread.unread === true
  const menu: RowAction[] = [{ id: "rename", label: t("sidebar.rename"), run: rename }]
  if (setPinned && thread.archivedAt === null) {
    const pinned = thread.pinned === true
    menu.push({
      id: pinned ? "unpin" : "pin",
      label: t(pinned ? "sidebar.unpin" : "sidebar.pin"),
      run: () => setPinned(!pinned),
    })
  }
  if (markRead && (unread || (FINISHED.has(status) && !active))) {
    menu.push({
      id: unread ? "mark-read" : "mark-unread",
      label: t(unread ? "sidebar.markRead" : "sidebar.markUnread"),
      run: () => markRead(unread),
    })
  }
  if (reference && !active) {
    menu.push({ id: "reference", label: t("sidebar.reference"), run: reference })
  }
  if (thread.archivedAt === null) {
    menu.push({ id: "archive", label: t("sidebar.archive"), run: archive })
  } else if (unarchive) {
    menu.push({ id: "unarchive", label: t("sidebar.unarchive"), run: unarchive })
  }
  return menu
}

/** 项目行的菜单。改名和移除两个都给时才有它们与挪动；previous、next 是侧栏里上下相邻的项目。 */
export function projectMenu({
  t,
  previous,
  next,
  browse,
  reveal,
  rename,
  move,
  remove,
}: {
  t: Translate
  previous?: string | undefined
  next?: string | undefined
  browse?: (() => void) | undefined
  /** 在文件管理器中打开项目文件夹；远程主机不传此项。 */
  reveal?: (() => void) | undefined
  rename?: (() => void) | undefined
  move: (target: string, place: "before" | "after") => void
  remove?: (() => void) | undefined
}): RowAction[] {
  const menu: RowAction[] = browse
    ? [{ id: "browse-files", label: t("files.viewProjectFiles"), run: browse }]
    : []
  if (!rename || !remove) return menu
  if (reveal) menu.push({ id: "open-folder", label: t(revealLabelKey()), run: reveal })
  menu.push({ id: "rename", label: t("sidebar.rename"), run: rename })
  const moves: RowAction[] = []
  if (previous) {
    moves.push({ id: "move-up", label: t("sidebar.moveUp"), run: () => move(previous, "before") })
  }
  if (next)
    moves.push({ id: "move-down", label: t("sidebar.moveDown"), run: () => move(next, "after") })
  if (moves[0]) moves[0] = { ...moves[0], separated: true }
  menu.push(...moves, {
    id: "remove",
    label: t("sidebar.removeProject"),
    separated: true,
    run: remove,
  })
  return menu
}
