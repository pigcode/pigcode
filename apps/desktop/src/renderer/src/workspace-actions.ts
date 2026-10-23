/** 侧栏上对项目和会话的操作：先让 Host 落库，再把返回的记录写回 store。 */
import type { Project, Thread } from "@pigcode/contracts"
import type { AppStore, Connection } from "@pigcode/client-runtime"

/** 用 Host 返回的记录替换 store 里的同一个会话。 */
function replaceThread(store: AppStore, thread: Thread): void {
  store.update({
    threads: store.getSnapshot().threads.map((item) => (item.id === thread.id ? thread : item)),
  })
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
