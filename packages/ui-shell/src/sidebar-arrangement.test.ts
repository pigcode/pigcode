/** 验证侧栏怎么摆会话：分组、排序、状态筛选、只看已归档，以及项目的手动顺序。 */
import { describe, expect, it } from "vitest"
import type { Project, Thread } from "@pigcode/contracts"
import { DEFAULT_SIDEBAR_VIEW, type SidebarView } from "@pigcode/ui-primitives"
import {
  moveProject,
  orderProjects,
  projectOrder,
  sidebarSections,
  timeBucket,
  visibleThreads,
  type SidebarArrangement,
} from "./sidebar-arrangement"

const project = (id: string): Project => ({
  id,
  rootPath: `/tmp/${id}`,
  name: id,
  createdAt: "2026-10-20T00:00:00.000Z",
})

const thread = (id: string, projectId: string, updatedAt: string, patch: Partial<Thread> = {}) =>
  ({
    id,
    projectId,
    title: id,
    defaultAgentId: "claude",
    defaultInstanceId: null,
    lastAgentId: null,
    lastInstanceId: null,
    lastModelId: null,
    permissionMode: "workspace-write",
    createdAt: updatedAt,
    updatedAt,
    archivedAt: null,
    lastRunId: null,
    ...patch,
  }) satisfies Thread

const NOW = new Date("2026-11-21T12:00:00").getTime()

function arrange(
  patch: Omit<Partial<SidebarArrangement>, "view"> & { view?: Partial<SidebarView> } = {},
) {
  return {
    grouping: "project",
    status: {},
    expandedProjects: {},
    now: NOW,
    ...patch,
    view: { ...DEFAULT_SIDEBAR_VIEW, ...patch.view },
  } satisfies SidebarArrangement
}

const ids = (list: Array<{ id: string }>) => list.map((item) => item.id)

describe("sidebar arrangement", () => {
  const projects = [project("p1"), project("p2")]
  const threads = [
    thread("t1", "p1", "2026-11-21T08:00:00"),
    thread("t2", "p2", "2026-11-21T10:00:00"),
    thread("t3", "p1", "2026-11-21T09:00:00"),
    thread("old", "p1", "2026-10-01T09:00:00"),
    thread("archived", "p1", "2026-11-21T11:00:00", { archivedAt: "2026-11-21T11:30:00" }),
    thread("orphan", "gone", "2026-11-21T11:00:00"),
  ]

  it("lists live threads newest first inside each project and skips collapsed projects", () => {
    expect(ids(visibleThreads(projects, threads, arrange()))).toEqual(["t3", "t1", "old", "t2"])
    expect(
      ids(visibleThreads(projects, threads, arrange({ expandedProjects: { p1: false } }))),
    ).toEqual(["t2"])
  })

  it("shows pinned threads once at the top under each grouping and applies the current order and filter", () => {
    const pool = threads.map((item): Thread => {
      if (item.id === "old") return { ...item, pinned: true, status: "waiting-approval" }
      if (item.id === "t1") return { ...item, pinned: true, status: "completed" }
      if (item.id === "archived" || item.id === "orphan") return { ...item, pinned: true }
      return item
    })
    for (const grouping of ["project", "time", "status"] as const) {
      const ordered = arrange({ grouping, view: { threadOrder: "updated" } })
      const sections = sidebarSections(projects, pool, ordered)
      expect(sections[0]?.kind).toBe("pinned")
      expect(ids(sections[0]?.threads ?? [])).toEqual(["t1", "old"])
      expect(ids(sections.slice(1).flatMap((section) => section.threads))).not.toContain("t1")
      expect(ids(sections.slice(1).flatMap((section) => section.threads))).not.toContain("old")
    }

    const collapsed = arrange({ expandedProjects: { p1: false }, view: { threadOrder: "status" } })
    expect(ids(visibleThreads(projects, pool, collapsed))).toEqual(["old", "t1", "t2"])
    const filtered = arrange({ view: { statusFilter: ["attention"] } })
    expect(ids(visibleThreads(projects, pool, filtered))).toEqual(["old"])
    expect(sidebarSections(projects, pool, filtered)).toMatchObject([
      { kind: "pinned" },
      { kind: "project", key: "p1", threads: [] },
    ])
    const archived = arrange({ view: { archived: true } })
    expect(sidebarSections(projects, pool, archived).map((section) => section.kind)).toEqual(["project"])
    expect(ids(visibleThreads(projects, pool, archived))).toEqual(["archived"])
  })

  it("cuts the list into today, yesterday, the last 7 and 30 days and older by local days", () => {
    const sections = sidebarSections(projects, threads, arrange({ grouping: "time" }))
    expect(sections.map((section) => [section.key, ids(section.threads)])).toEqual([
      ["today", ["t2", "t3", "t1"]],
      ["older", ["old"]],
    ])
    expect(timeBucket("2026-11-20T23:59:00", NOW)).toBe("yesterday")
    expect(timeBucket("2026-11-15T00:00:00", NOW)).toBe("week")
    expect(timeBucket("2026-11-14T00:00:00", NOW)).toBe("month")
    expect(timeBucket("2026-10-22T00:00:00", NOW)).toBe("older")
  })

  it("groups by status, holds the thread just opened from 「需要处理」, and sorts by status", () => {
    const pool = [
      thread("waiting", "p1", "2026-11-21T08:00:00"),
      thread("failed", "p1", "2026-11-21T09:00:00"),
      thread("fresh", "p1", "2026-11-21T07:00:00", { unread: true }),
      thread("running", "p1", "2026-11-21T10:00:00"),
      thread("draft", "p1", "2026-11-21T06:00:00"),
      thread("seen", "p2", "2026-11-21T11:00:00"),
    ]
    const status = {
      waiting: "waiting-approval",
      failed: "failed",
      fresh: "completed",
      running: "running",
      draft: "idle",
      seen: "completed",
    } as const
    const sections = sidebarSections(projects, pool, arrange({ grouping: "status", status }))
    expect(sections.map((section) => [section.key, ids(section.threads)])).toEqual([
      ["attention", ["waiting", "fresh"]],
      ["error", ["failed"]],
      ["working", ["running"]],
      ["draft", ["draft"]],
      ["done", ["seen"]],
    ])
    // 打开以后已经读过了，但看着它的时候还留在「需要处理」。
    const read = pool.map((item) => (item.id === "fresh" ? { ...item, unread: false } : item))
    const held = arrange({ grouping: "status", status, heldThreadId: "fresh" })
    expect(sidebarSections(projects, read, held)[0]?.threads.map((item) => item.id)).toEqual([
      "waiting",
      "fresh",
    ])
    expect(
      ids(
        visibleThreads(
          projects,
          pool,
          arrange({ grouping: "time", status, view: { threadOrder: "status" } }),
        ),
      ),
    ).toEqual(["waiting", "failed", "fresh", "running", "draft", "seen"])
  })

  it("filters by status the way Cursor does, and shows only archived threads when asked", () => {
    const pool = [
      thread("waiting", "p1", "2026-11-21T08:00:00"),
      thread("fresh", "p1", "2026-11-21T07:00:00", { unread: true }),
      thread("running", "p1", "2026-11-21T10:00:00"),
      thread("seen", "p2", "2026-11-21T11:00:00"),
    ]
    const status = {
      waiting: "waiting-approval",
      fresh: "completed",
      running: "running",
      seen: "completed",
    } as const
    const only = (statusFilter: SidebarView["statusFilter"]) =>
      ids(
        visibleThreads(
          projects,
          pool,
          arrange({ grouping: "time", status, view: { statusFilter } }),
        ),
      )
    expect(only(["done"])).toEqual(["seen", "fresh"])
    // 「未读」带上进行中和需要处理的：有新东西要看的都算。
    expect(only(["unread"])).toEqual(["running", "waiting", "fresh"])
    // 按项目分组时，筛选后没有会话的项目不再列出来。
    expect(
      sidebarSections(
        projects,
        pool,
        arrange({ status, view: { statusFilter: ["attention"] } }),
      ).map((section) => section.key),
    ).toEqual(["p1"])
    expect(ids(visibleThreads(projects, threads, arrange({ view: { archived: true } })))).toEqual([
      "archived",
    ])
  })

  it("orders projects by hand with new ones last, or by their latest thread", () => {
    const three = [...projects, project("p3")]
    const manual: Pick<SidebarView, "projectOrder" | "projectIds"> = {
      projectOrder: "manual",
      projectIds: ["p2", "gone", "p1"],
    }
    expect(ids(orderProjects(three, threads, manual))).toEqual(["p2", "p1", "p3"])
    expect(ids(orderProjects(three, threads, { ...manual, projectOrder: "updated" }))).toEqual([
      "p1",
      "p2",
      "p3",
    ])
    expect(projectOrder(three, threads, { ...DEFAULT_SIDEBAR_VIEW, ...manual })).toEqual([
      "p2",
      "p1",
      "p3",
    ])
    expect(moveProject(["p1", "p2", "p3"], "p3", "p1", "before")).toEqual(["p3", "p1", "p2"])
    expect(moveProject(["p1", "p2", "p3"], "p1", "p2", "after")).toEqual(["p2", "p1", "p3"])
    expect(moveProject(["p1", "p2"], "p1", "p1", "after")).toEqual(["p1", "p2"])
  })
})
