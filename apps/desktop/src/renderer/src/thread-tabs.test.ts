/** 验证标签栏的组装：子代理顺序、派生子代理的显示规则与侧栏状态合并。 */
import type { Thread } from "@pigcode/contracts"
import type { SubagentCall } from "@pigcode/ui-chat"
import { afterEach, describe, expect, it } from "vitest"
import { mergeChildStatus } from "./app"
import {
  buildThreadTabs,
  childThreads,
  dismissSpawnedTab,
  openSpawnedTab,
  resetThreadTabs,
  selectThreadTab,
  threadTabState,
  visibleSpawned,
  type ThreadTabState,
} from "./thread-tabs"

afterEach(resetThreadTabs)

function thread(id: string, patch: Partial<Thread> = {}): Thread {
  return {
    id,
    projectId: "p1",
    title: id,
    defaultAgentId: "fake",
    defaultInstanceId: null,
    lastAgentId: null,
    lastInstanceId: null,
    lastModelId: null,
    permissionMode: "workspace-write",
    createdAt: "2026-10-21T00:00:00.000Z",
    updatedAt: "2026-10-21T00:00:00.000Z",
    archivedAt: null,
    lastRunId: null,
    parentThreadId: null,
    ...patch,
  }
}

function spawned(
  id: string,
  runId: string,
  status: SubagentCall["status"] = "completed",
): SubagentCall {
  return { id, name: "Explore", description: `task ${id}`, status, events: [], runId }
}

const STATE: ThreadTabState = { selected: "main", dismissed: new Set(), opened: new Set() }

describe("thread tabs", () => {
  it("lists live sub-agents of a main thread in creation order", () => {
    const threads = [
      thread("main"),
      thread("late", { parentThreadId: "main", createdAt: "2026-10-21T02:00:00.000Z" }),
      thread("early", { parentThreadId: "main", createdAt: "2026-10-21T01:00:00.000Z" }),
      thread("gone", { parentThreadId: "main", archivedAt: "2026-10-21T03:00:00.000Z" }),
      thread("other", { parentThreadId: "else" }),
    ]
    expect(childThreads(threads, "main").map((item) => item.id)).toEqual(["early", "late"])
    expect(childThreads(threads, null)).toEqual([])
  })

  it("shows the latest run's spawned sub-agents plus the ones opened from the timeline", () => {
    const subagents = new Map([
      ["old", spawned("old", "run_1")],
      ["a", spawned("a", "run_2")],
      ["b", spawned("b", "run_2", "running")],
    ])
    expect(visibleSpawned(subagents, STATE).map((item) => item.id)).toEqual(["a", "b"])
    expect(
      visibleSpawned(subagents, {
        ...STATE,
        opened: new Set(["old"]),
        dismissed: new Set(["a"]),
      }).map((item) => item.id),
    ).toEqual(["old", "b"])
  })

  it("builds the main tab, sub-agent tabs with their run state and spawned tabs", () => {
    const tabs = buildThreadTabs({
      main: thread("main", { title: "修登录" }),
      projectName: "demo",
      children: [thread("c1", { title: "Codex 子代理", lastAgentId: "codex" })],
      statuses: { c1: "waiting-approval" },
      spawned: [spawned("s1", "run_1", "running")],
    })
    expect(tabs).toEqual([
      { id: "main", kind: "main", title: "修登录", description: "demo / 修登录" },
      {
        id: "agent:c1",
        kind: "agent",
        title: "Codex 子代理",
        agentId: "codex",
        running: true,
        waiting: true,
        closable: true,
      },
      {
        id: "spawned:s1",
        kind: "spawned",
        title: "task s1",
        description: "Explore · task s1",
        running: true,
        closable: true,
      },
    ])
  })

  it("remembers the selected tab per main thread and reopens dismissed spawned tabs", () => {
    selectThreadTab("main", "spawned:s1")
    expect(threadTabState("main").selected).toBe("spawned:s1")
    expect(threadTabState("other").selected).toBe("main")
    // 关掉正在看的派生标签时回到主会话。
    dismissSpawnedTab("main", "s1")
    expect(threadTabState("main")).toMatchObject({ selected: "main", dismissed: new Set(["s1"]) })
    // 从时间线重新打开：不再算关掉，并选中它。
    openSpawnedTab("main", "s1")
    const state = threadTabState("main")
    expect(state).toMatchObject({ selected: "spawned:s1", dismissed: new Set() })
    const subagents = new Map([
      ["s1", spawned("s1", "run_0")],
      ["s2", spawned("s2", "run_1")],
    ])
    expect(visibleSpawned(subagents, state).map((item) => item.id)).toEqual(["s1", "s2"])
  })

  it("shows a busy sub-agent on its idle main thread in the sidebar", () => {
    const threads = [thread("main"), thread("c1", { parentThreadId: "main" }), thread("solo")]
    expect(
      mergeChildStatus(threads, {
        main: { status: "completed" },
        c1: { status: "running" },
        solo: { status: "idle" },
      }),
    ).toEqual({ main: "running", c1: "running", solo: "idle" })
    expect(
      mergeChildStatus(threads, {
        main: { status: "waiting-approval" },
        c1: { status: "running" },
      }),
    ).toMatchObject({ main: "waiting-approval" })
  })
})
