/** 验证侧栏右键菜单的会话操作：Host 返回的记录写回 store，归档后选好下一个会话。 */
import { describe, expect, it, vi } from "vitest"
import type { Project, Thread } from "@pigcode/contracts"
import { AppStore, type Connection } from "@pigcode/client-runtime"
import {
  addProject,
  archiveThread,
  loadWorkspace,
  removeProject,
  renameProject,
  renameThread,
} from "./workspace-actions"

const project = (id: string): Project => ({
  id,
  rootPath: `/tmp/${id}`,
  name: id,
  createdAt: "2026-10-20T00:00:00.000Z",
})

const thread = (id: string, projectId: string, updatedAt: string): Thread => ({
  id,
  projectId,
  title: id,
  defaultAgentId: "fake",
  lastAgentId: null,
  lastModelId: null,
  permissionMode: "workspace-write",
  createdAt: updatedAt,
  updatedAt,
  archivedAt: null,
  lastRunId: null,
})

/** 只实现 call 与 closeThread 的连接替身；call 按方法名返回 Host 的结果。 */
function fakeConnection(
  results: Record<string, (params: { threadId: string; projectId: string }) => unknown>,
) {
  const call = vi.fn(async (method: string, params: unknown) => {
    const result = results[method]
    if (!result) throw new Error(`unexpected ${method}`)
    return result(params as { threadId: string; projectId: string })
  })
  const closeThread = vi.fn<(threadId: string) => Promise<void>>(async () => undefined)
  return { connection: { call, closeThread } as unknown as Connection, call, closeThread }
}

function storeWith(threads: Thread[], activeThreadId: string | null): AppStore {
  const store = new AppStore()
  store.update({ projects: [project("p1"), project("p2")], threads })
  for (const item of threads) store.openThread(item.id)
  if (activeThreadId) store.setActiveThread(activeThreadId)
  return store
}

describe("workspace actions", () => {
  it("renames a thread with the record the Host returns", async () => {
    const store = storeWith([thread("t1", "p1", "2026-10-20T01:00:00.000Z")], null)
    const renamed = { ...thread("t1", "p1", "2026-10-21T00:00:00.000Z"), title: "Renamed" }
    const { connection, call } = fakeConnection({ "thread.rename": () => renamed })

    await renameThread(connection, store, "t1", "Renamed")

    expect(call).toHaveBeenCalledWith("thread.rename", { threadId: "t1", title: "Renamed" })
    expect(store.getSnapshot().threads).toEqual([renamed])
  })

  it("archives the open thread and moves on to the latest thread of the same project", async () => {
    const store = storeWith(
      [
        thread("t1", "p1", "2026-10-20T03:00:00.000Z"),
        thread("t2", "p2", "2026-10-20T04:00:00.000Z"),
        thread("t3", "p1", "2026-10-20T01:00:00.000Z"),
        thread("t4", "p1", "2026-10-20T02:00:00.000Z"),
      ],
      "t1",
    )
    const archivedAt = "2026-10-21T00:00:00.000Z"
    const { connection, closeThread } = fakeConnection({
      "thread.archive": ({ threadId }) => ({
        ...thread(threadId, "p1", "2026-10-20T03:00:00.000Z"),
        archivedAt,
      }),
    })

    await expect(archiveThread(connection, store, "t1")).resolves.toBe("t4")
    const state = store.getSnapshot()
    expect(state.threads.find((item) => item.id === "t1")?.archivedAt).toBe(archivedAt)
    expect(state.openThreadIds).not.toContain("t1")
    expect(state.threadStates.t1).toBeUndefined()
    expect(closeThread).toHaveBeenCalledWith("t1")
  })

  it("falls back to another project, then to nothing, and keeps the view when archiving another thread", async () => {
    const archive = ({ threadId }: { threadId: string }) => ({
      ...thread(threadId, threadId === "t2" ? "p2" : "p1", "2026-10-20T00:00:00.000Z"),
      archivedAt: "2026-10-21T00:00:00.000Z",
    })
    const store = storeWith(
      [
        thread("t1", "p1", "2026-10-20T03:00:00.000Z"),
        thread("t2", "p2", "2026-10-20T04:00:00.000Z"),
      ],
      "t1",
    )
    const { connection } = fakeConnection({ "thread.archive": archive })

    await expect(archiveThread(connection, store, "t1")).resolves.toBe("t2")
    store.setActiveThread("t2")
    await expect(archiveThread(connection, store, "t2")).resolves.toBeNull()
    expect(store.getSnapshot().activeThreadId).toBeNull()

    const other = storeWith(
      [
        thread("t1", "p1", "2026-10-20T03:00:00.000Z"),
        thread("t3", "p1", "2026-10-20T01:00:00.000Z"),
      ],
      "t1",
    )
    await expect(archiveThread(connection, other, "t3")).resolves.toBeNull()
    expect(other.getSnapshot().activeThreadId).toBe("t1")
  })

  it("adds a project once and keeps projects in creation order when one comes back", async () => {
    const store = new AppStore()
    const restored = { ...project("p0"), createdAt: "2026-10-01T00:00:00.000Z" }
    store.update({ projects: [project("p1")] })
    const { connection } = fakeConnection({ "project.add": () => restored })

    await addProject(connection, store, "/tmp/p0")
    await addProject(connection, store, "/tmp/p0")

    expect(store.getSnapshot().projects.map((item) => item.id)).toEqual(["p0", "p1"])
    expect(store.getSnapshot().activeProjectId).toBe("p0")
  })

  it("keeps a project and a thread added while the first load is still running", async () => {
    const store = new AppStore()
    const added = { ...project("p2"), createdAt: "2026-10-21T00:00:00.000Z" }
    const created = thread("t-new", "p2", "2026-10-21T00:00:00.000Z")
    let releaseThreads!: () => void
    const threadsListed = new Promise<void>((resolve) => (releaseThreads = resolve))
    const { connection } = fakeConnection({
      "project.list": () => [project("p1")],
      "thread.list": async () => {
        await threadsListed
        return [thread("t-old", "p1", "2026-10-20T00:00:00.000Z")]
      },
      "project.add": () => added,
    })

    const loading = loadWorkspace(connection, store)
    await addProject(connection, store, "/tmp/p2")
    store.update({ threads: [created, ...store.getSnapshot().threads] })
    releaseThreads()
    await loading

    expect(store.getSnapshot().projects.map((item) => item.id)).toEqual(["p1", "p2"])
    expect(store.getSnapshot().threads.map((item) => item.id)).toEqual(["t-new", "t-old"])
  })

  it("renames a project with the record the Host returns", async () => {
    const store = storeWith([], null)
    const { connection, call } = fakeConnection({
      "project.rename": () => ({ ...project("p2"), name: "新名字" }),
    })

    await renameProject(connection, store, "p2", "新名字")

    expect(call).toHaveBeenCalledWith("project.rename", { projectId: "p2", name: "新名字" })
    expect(store.getSnapshot().projects.map((item) => item.name)).toEqual(["p1", "新名字"])
  })

  it("removes a project, closes its threads and moves to the latest thread elsewhere", async () => {
    const store = storeWith(
      [
        thread("t1", "p1", "2026-10-20T03:00:00.000Z"),
        thread("t2", "p1", "2026-10-20T04:00:00.000Z"),
        thread("t3", "p2", "2026-10-20T01:00:00.000Z"),
      ],
      "t1",
    )
    const { connection, closeThread } = fakeConnection({ "project.remove": () => project("p1") })

    await expect(removeProject(connection, store, "p1")).resolves.toBe("t3")
    const state = store.getSnapshot()
    expect(state.projects.map((item) => item.id)).toEqual(["p2"])
    expect(state.openThreadIds).toEqual(["t3"])
    expect(closeThread.mock.calls.map(([id]) => id)).toEqual(["t1", "t2"])
    await expect(removeProject(connection, store, "p1")).resolves.toBeNull()
  })
})
