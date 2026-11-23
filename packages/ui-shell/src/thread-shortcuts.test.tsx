/** 验证 ⌘/Ctrl+数字按侧栏看到的顺序打开会话：分组、排序、筛选，以及留在原处的会话。 */
// @vitest-environment jsdom
import { cleanup, fireEvent, renderHook } from "@testing-library/react"
import { afterEach, expect, it, vi } from "vitest"
import type { Project, Thread } from "@pigcode/contracts"
import { DEFAULT_SIDEBAR_VIEW } from "@pigcode/ui-primitives"
import { visibleThreads } from "./sidebar-arrangement"
import { renderSidebar, thread } from "./sidebar.fixtures"
import { useThreadShortcuts } from "./thread-shortcuts"

afterEach(() => {
  cleanup()
  window.localStorage.removeItem("pigcode.sidebarGrouping")
  window.localStorage.removeItem("pigcode.sidebarView")
})

const projects: Project[] = [
  { id: "p1", rootPath: "/tmp/alpha", name: "alpha", createdAt: "2026-10-20T00:00:00.000Z" },
]
const threads: Thread[] = ["t1", "t2", "t3", "t4"].map((id, index) => ({
  id,
  projectId: "p1",
  title: id,
  defaultAgentId: "fake",
  defaultInstanceId: null,
  lastAgentId: null,
  lastInstanceId: null,
  lastModelId: null,
  permissionMode: "workspace-write",
  createdAt: "2026-10-20T00:00:00.000Z",
  updatedAt: `2026-10-20T0${index}:00:00.000Z`,
  archivedAt: null,
  lastRunId: null,
}))

const press = (digit: number) =>
  fireEvent.keyDown(window, { key: String(digit), code: `Digit${digit}`, ctrlKey: true })

it("follows the status sections and the status filter, and leaves the held thread in place", () => {
  const onOpen = vi.fn()
  let view = DEFAULT_SIDEBAR_VIEW
  const status = {
    t1: "waiting-approval",
    t2: "running",
    t3: "completed",
    t4: "completed",
  } as const
  const { rerender } = renderHook((held: string | null) =>
    useThreadShortcuts({
      enabled: true,
      threads: visibleThreads(projects, threads, {
        grouping: "status",
        view,
        status,
        expandedProjects: {},
        heldThreadId: held,
        now: 0,
      }),
      onOpen,
    }),
  )
  rerender(null)
  press(1)
  press(2)
  press(3)
  // 需要处理、进行中，然后已完成里新的在上面。
  expect(onOpen.mock.calls).toEqual([["t1"], ["t2"], ["t4"]])

  // 刚从「需要处理」打开的 t3 看着的时候留在那一段，比 t1 新，排在它上面。
  onOpen.mockClear()
  rerender("t3")
  press(1)
  press(2)
  expect(onOpen.mock.calls).toEqual([["t3"], ["t1"]])

  onOpen.mockClear()
  view = { ...DEFAULT_SIDEBAR_VIEW, statusFilter: ["done"] }
  rerender(null)
  press(1)
  expect(onOpen).toHaveBeenCalledExactlyOnceWith("t4")
})

it("does nothing while disabled, for example in settings", () => {
  const onOpen = vi.fn()
  renderHook(() =>
    useThreadShortcuts({
      enabled: false,
      threads,
      onOpen,
    }),
  )
  press(1)
  expect(onOpen).not.toHaveBeenCalled()
})

it("uses the displayed shortcut order while the sidebar clock crosses midnight", () => {
  window.localStorage.setItem("pigcode.sidebarGrouping", "time")
  window.localStorage.setItem("pigcode.sidebarView", JSON.stringify({ threadOrder: "status" }))
  const clock = vi.spyOn(Date, "now").mockReturnValue(new Date("2026-11-23T23:59:30").getTime())
  const onOpenThread = vi.fn()
  try {
    const { container } = renderSidebar({
      threads: [
        { ...thread("pinned", "p1", "置顶目标", "2026-11-20T10:00:00"), pinned: true },
        thread("yesterday", "p1", "昨天的会话", "2026-11-22T10:00:00"),
        thread("waiting", "p1", "等审批的会话", "2026-11-21T10:00:00"),
      ],
      threadStatus: { yesterday: "completed", waiting: "waiting-approval" },
      enableThreadShortcuts: true,
      onOpenThread,
    })
    const titles = Array.from(container.querySelectorAll(".sess .list-row-title"), (row) => row.textContent)
    expect(titles).toEqual(["置顶目标", "昨天的会话", "等审批的会话"])
    clock.mockReturnValue(new Date("2026-11-24T00:00:01").getTime())
    press(2)
    expect(onOpenThread).toHaveBeenCalledExactlyOnceWith("yesterday")
  } finally {
    clock.mockRestore()
  }
})
