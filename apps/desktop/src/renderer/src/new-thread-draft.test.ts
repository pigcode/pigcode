/**
 * 验证新会话草稿：落到哪个项目，按草稿里选好的 agent、模型与权限建会话并打开它，
 * 以及草稿输入框里还没发的内容跟着搬进新会话。
 */
import { afterEach, describe, expect, it, vi } from "vitest"
import type { Project, Thread } from "@pigcode/contracts"
import { AppStore, type Connection } from "@pigcode/client-runtime"
import { moveComposerDraft } from "@pigcode/ui-composer"
import {
  NEW_THREAD_DRAFT_KEY,
  draftProjectId,
  materializeDraft,
  resetDraftOptions,
  updateDraftOptions,
} from "./new-thread-draft"

vi.mock("@pigcode/ui-composer", () => ({ moveComposerDraft: vi.fn() }))

afterEach(() => {
  resetDraftOptions()
  vi.mocked(moveComposerDraft).mockReset()
})

const project = (id: string): Project => ({
  id,
  rootPath: `/tmp/${id}`,
  name: id,
  createdAt: "2026-10-20T00:00:00.000Z",
})

const created: Thread = {
  id: "t-new",
  projectId: "p2",
  title: "新会话",
  defaultAgentId: "claude",
  lastAgentId: null,
  lastModelId: null,
  permissionMode: "workspace-write",
  createdAt: "2026-11-07T00:00:00.000Z",
  updatedAt: "2026-11-07T00:00:00.000Z",
  archivedAt: null,
  lastRunId: null,
}

function fakeConnection(defaultAgent: string | null = "claude") {
  const call = vi.fn(async (method: string) => {
    if (method === "agent.default") return { id: defaultAgent }
    if (method === "thread.create") return created
    throw new Error(`unexpected ${method}`)
  })
  const openThread = vi.fn(async () => undefined)
  return { connection: { call, openThread } as unknown as Connection, call, openThread }
}

function storeWith(activeProjectId: string | null): AppStore {
  const store = new AppStore()
  store.update({ projects: [project("p1"), project("p2")], activeProjectId })
  return store
}

describe("new thread draft", () => {
  it("lands in the most recently used project, or the first one", () => {
    expect(
      draftProjectId({ projects: [project("p1"), project("p2")], activeProjectId: "p2" }),
    ).toBe("p2")
    expect(
      draftProjectId({ projects: [project("p1"), project("p2")], activeProjectId: "gone" }),
    ).toBe("p1")
    expect(draftProjectId({ projects: [], activeProjectId: null })).toBeNull()
  })

  it("creates the thread with the default agent and opens it as the current thread", async () => {
    const store = storeWith("p2")
    const { connection, call, openThread } = fakeConnection()

    await materializeDraft(connection, store, "zh-CN")

    expect(call).toHaveBeenCalledWith("thread.create", {
      projectId: "p2",
      title: "新会话",
      agentId: "claude",
    })
    expect(store.getSnapshot()).toMatchObject({
      activeThreadId: "t-new",
      activeProjectId: "p2",
      openThreadIds: ["t-new"],
    })
    expect(store.getSnapshot().threads.map((thread) => thread.id)).toEqual(["t-new"])
    expect(openThread).toHaveBeenCalledWith("t-new")
  })

  it("carries the draft input over while the draft is still showing, and knows the thread is empty", async () => {
    const store = storeWith("p2")
    const { connection } = fakeConnection()
    let activeWhenMoved: string | null | undefined
    vi.mocked(moveComposerDraft).mockImplementation(() => {
      activeWhenMoved = store.getSnapshot().activeThreadId
    })

    await materializeDraft(connection, store, "zh-CN")

    expect(moveComposerDraft).toHaveBeenCalledWith(NEW_THREAD_DRAFT_KEY, "t-new")
    expect(activeWhenMoved).toBeNull()
    // 刚建好的会话没有历史要回放：不用等订阅就能显示问候。
    expect(store.getSnapshot().threadStates["t-new"]?.loaded).toBe(true)
  })

  it("passes on the agent, model and permission chosen in the draft", async () => {
    updateDraftOptions({ agentId: "codex", modelId: "gpt-5", permissionMode: "read-only" })
    const { connection, call } = fakeConnection()

    await materializeDraft(connection, storeWith("p1"), "zh-CN")

    expect(call).not.toHaveBeenCalledWith("agent.default", expect.anything())
    expect(call).toHaveBeenCalledWith("thread.create", {
      projectId: "p1",
      title: "新会话",
      agentId: "codex",
      modelId: "gpt-5",
      permissionMode: "read-only",
    })
  })

  it("refuses without a project or an agent, and creates nothing", async () => {
    const empty = new AppStore()
    const { connection, call } = fakeConnection()
    await expect(materializeDraft(connection, empty, "zh-CN")).rejects.toThrow(
      "先选择或添加一个项目",
    )
    expect(call).not.toHaveBeenCalled()

    const noAgent = fakeConnection(null)
    await expect(materializeDraft(noAgent.connection, storeWith("p1"), "zh-CN")).rejects.toThrow(
      "没有可用的 agent",
    )
    expect(noAgent.call).not.toHaveBeenCalledWith("thread.create", expect.anything())
    // 没建成会话时草稿原样留着。
    expect(moveComposerDraft).not.toHaveBeenCalled()
  })
})
