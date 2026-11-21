/** 侧栏上对项目和会话的操作：先让 Host 落库，再把返回的记录写回 store。 */
import type { Project, Thread } from "@pigcode/contracts"
import type { AppStore, Connection } from "@pigcode/client-runtime"

export async function projectFilePaths(
  connection: Connection,
  projectId: string,
): Promise<string[]> {
  const entries = (await connection.call("project.files", { projectId })) as Array<{ path: string }>
  return entries.map((entry) => entry.path)
}

/** 用 Host 返回的记录替换 store 里的同一批会话。 */
function replaceThreads(store: AppStore, records: readonly Thread[]): void {
  const byId = new Map(records.map((thread) => [thread.id, thread]))
  store.update({
    threads: store.getSnapshot().threads.map((item) => byId.get(item.id) ?? item),
  })
}

function replaceThread(store: AppStore, thread: Thread): void {
  replaceThreads(store, [thread])
}

/** 项目按创建时间排列，与 Host 的 project.list 一致。 */
function byCreation(projects: Project[]): Project[] {
  return [...projects].sort((left, right) => left.createdAt.localeCompare(right.createdAt))
}

/** 接着看的会话：优先同一项目里最近更新的，没有时取所有项目里最近的；子代理不算。 */
function nextThread(store: AppStore, preferProjectId: string | null): string | null {
  const { threads, projects } = store.getSnapshot()
  const known = new Set(projects.map((project) => project.id))
  const live = threads
    .filter(
      (thread) =>
        thread.archivedAt === null && !thread.parentThreadId && known.has(thread.projectId),
    )
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
  return (live.find((thread) => thread.projectId === preferProjectId) ?? live[0])?.id ?? null
}

/** 关掉会话的 tab 与事件订阅。 */
function closeThread(connection: Connection, store: AppStore, threadId: string): void {
  store.closeThread(threadId)
  void connection.closeThread(threadId).catch(() => undefined)
}

/**
 * 首次连上 Host 后读取项目与会话。读取期间新加的项目、新建的会话已经写进 store，
 * 这里合并而不是覆盖，否则它们会从侧栏消失。
 */
export async function loadWorkspace(connection: Connection, store: AppStore): Promise<void> {
  const projects = (await connection.call("project.list", {})) as Project[]
  const threads = (await connection.call("thread.list", {})) as Thread[]
  const current = store.getSnapshot()
  const addedProjects = new Set(current.projects.map((item) => item.id))
  const addedThreads = new Set(current.threads.map((item) => item.id))
  store.update({
    projects: byCreation([
      ...current.projects,
      ...projects.filter((item) => !addedProjects.has(item.id)),
    ]),
    threads: [...current.threads, ...threads.filter((item) => !addedThreads.has(item.id))],
  })
}

/** 添加项目；Host 对已在列表里或移除过的同一文件夹返回原来的项目，这里按 id 去重。 */
export async function addProject(
  connection: Connection,
  store: AppStore,
  rootPath: string,
  name?: string,
): Promise<void> {
  const project = (await connection.call(
    "project.add",
    name ? { rootPath, name } : { rootPath },
  )) as Project
  const current = store.getSnapshot()
  store.update({
    projects: byCreation([...current.projects.filter((item) => item.id !== project.id), project]),
    activeProjectId: project.id,
    error: null,
  })
}

/** 重命名项目。 */
export async function renameProject(
  connection: Connection,
  store: AppStore,
  projectId: string,
  name: string,
): Promise<void> {
  const project = (await connection.call("project.rename", { projectId, name })) as Project
  store.update({
    projects: store.getSnapshot().projects.map((item) => (item.id === project.id ? project : item)),
  })
}

/**
 * 从侧栏移除项目，它的会话随之隐藏并退订。正在看的会话属于这个项目时，
 * 返回接下来要打开的会话；否则或者已经没有别的会话时返回 null。
 */
export async function removeProject(
  connection: Connection,
  store: AppStore,
  projectId: string,
): Promise<string | null> {
  await connection.call("project.remove", { projectId })
  const before = store.getSnapshot()
  const viewing = before.threads.find((thread) => thread.id === before.activeThreadId)
  store.update({
    projects: before.projects.filter((project) => project.id !== projectId),
    activeProjectId: before.activeProjectId === projectId ? null : before.activeProjectId,
  })
  for (const thread of before.threads) {
    if (thread.projectId === projectId && before.openThreadIds.includes(thread.id)) {
      closeThread(connection, store, thread.id)
    }
  }
  return viewing?.projectId === projectId ? nextThread(store, null) : null
}

/** 重命名会话；没打开过的会话收不到 thread.updated，所以直接用返回值更新侧栏。 */
export async function renameThread(
  connection: Connection,
  store: AppStore,
  threadId: string,
  title: string,
): Promise<void> {
  const thread = (await connection.call("thread.rename", { threadId, title })) as Thread
  replaceThread(store, thread)
}

/**
 * 归档会话并退订它的事件。归档的是正在看的会话时，返回接下来要打开的会话
 * （同一项目里最近的优先）；否则或者已经没有别的会话时返回 null。
 */
export async function archiveThread(
  connection: Connection,
  store: AppStore,
  threadId: string,
): Promise<string | null> {
  const archived = (await connection.call("thread.archive", { threadId })) as Thread
  replaceThread(store, archived)
  const wasActive = store.getSnapshot().activeThreadId === threadId
  closeThread(connection, store, threadId)
  // Host 把子代理和主会话一起归档了；这里同步记录并退订它们。
  for (const child of store.getSnapshot().threads) {
    if (child.parentThreadId !== threadId || child.archivedAt !== null) continue
    replaceThread(store, { ...child, archivedAt: archived.archivedAt })
    if (store.getSnapshot().openThreadIds.includes(child.id))
      closeThread(connection, store, child.id)
  }
  return wasActive ? nextThread(store, archived.projectId) : null
}

/** 取消归档；一起归档的子代理由 Host 的 thread.changed 带回来。 */
export async function unarchiveThread(
  connection: Connection,
  store: AppStore,
  threadId: string,
): Promise<void> {
  replaceThread(store, (await connection.call("thread.unarchive", { threadId })) as Thread)
}

/** 标为已读或未读。标已读时先改 store，正在看的会话跑完时侧栏不会闪一下未读。 */
export async function setThreadRead(
  connection: Connection,
  store: AppStore,
  threadId: string,
  read: boolean,
): Promise<void> {
  const current = store.getSnapshot().threads.find((thread) => thread.id === threadId)
  if (read && current?.unread) replaceThread(store, { ...current, unread: false })
  replaceThread(store, (await connection.call("thread.markRead", { threadId, read })) as Thread)
}

/** 侧栏菜单里的「全部标为已读」。 */
export async function markAllThreadsRead(connection: Connection, store: AppStore): Promise<void> {
  replaceThreads(store, (await connection.call("thread.markAllRead", {})) as Thread[])
}

/**
 * 侧栏右键菜单与「全部标为已读」接到 Host 的回调。归档或移除了正在看的会话时打开接下来的那个；
 * 失败交给 onError。
 */
export function sidebarActions(
  connection: Connection,
  store: AppStore,
  {
    openThread,
    onError,
  }: { openThread: (threadId: string) => void; onError: (error: unknown) => void },
) {
  const run = (task: Promise<unknown>) => void task.catch(onError)
  const openNext = (next: string | null) => {
    if (next) openThread(next)
  }
  return {
    onRenameThread: (threadId: string, title: string) =>
      run(renameThread(connection, store, threadId, title)),
    onArchiveThread: (threadId: string) =>
      run(archiveThread(connection, store, threadId).then(openNext)),
    onUnarchiveThread: (threadId: string) => run(unarchiveThread(connection, store, threadId)),
    onMarkThreadRead: (threadId: string, read: boolean) =>
      run(setThreadRead(connection, store, threadId, read)),
    onMarkAllRead: () => run(markAllThreadsRead(connection, store)),
    onRenameProject: (projectId: string, name: string) =>
      run(renameProject(connection, store, projectId, name)),
    onRemoveProject: (projectId: string) =>
      run(removeProject(connection, store, projectId).then(openNext)),
  }
}
