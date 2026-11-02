/** 验证侧栏渲染导航、项目与会话，以及会话的右键菜单与数字快捷键。 */
// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import type { ComponentProps } from "react"
import { afterEach, describe, expect, it, vi } from "vitest"
import { LocaleProvider } from "@pigcode/ui-primitives"
import { ToastProvider } from "./toast"
import { WorkspaceSidebar, visibleThreads } from "./workspace-sidebar"

afterEach(cleanup)

const project = (id: string, name: string) => ({
  id,
  rootPath: `/tmp/${name}`,
  name,
  createdAt: "2026-10-20T00:00:00.000Z",
})

const thread = (id: string, projectId: string, title: string, updatedAt: string) => ({
  id,
  projectId,
  title,
  defaultAgentId: "claude",
  lastAgentId: null,
  lastModelId: null,
  permissionMode: "workspace-write" as const,
  createdAt: updatedAt,
  updatedAt,
  archivedAt: null as string | null,
  lastRunId: null,
})

function renderSidebar(props: Partial<ComponentProps<typeof WorkspaceSidebar>> = {}) {
  return render(
    <LocaleProvider locale="zh-CN">
      <ToastProvider>
        <WorkspaceSidebar
          projects={[project("p1", "alpha")]}
          threads={[thread("t1", "p1", "First thread", "2026-10-20T01:00:00.000Z")]}
          activeThreadId={null}
          expandedProjects={{}}
          onAddProject={() => {}}
          onToggleProject={() => {}}
          onOpenThread={() => {}}
          onNewThread={() => {}}
          {...props}
        />
      </ToastProvider>
    </LocaleProvider>,
  )
}

/** 用替身代替 preload 暴露的原生桥。 */
function mockNative(value: Partial<NonNullable<Window["pigcodeNative"]>>): void {
  Object.defineProperty(window, "pigcodeNative", { configurable: true, value })
}

afterEach(() => {
  Reflect.deleteProperty(window, "pigcodeNative")
})

describe("visibleThreads", () => {
  it("lists live threads top to bottom as the sidebar shows them", () => {
    const projects = [project("p1", "alpha"), project("p2", "beta")]
    const threads = [
      thread("t1", "p1", "older", "2026-10-20T01:00:00.000Z"),
      thread("t2", "p2", "newest", "2026-10-20T03:00:00.000Z"),
      thread("t3", "p1", "middle", "2026-10-20T02:00:00.000Z"),
      {
        ...thread("t4", "p1", "archived", "2026-10-20T04:00:00.000Z"),
        archivedAt: "2026-10-21T00:00:00.000Z",
      },
      thread("t5", "gone", "no project", "2026-10-20T05:00:00.000Z"),
    ]
    const ids = (list: Array<{ id: string }>) => list.map((item) => item.id)

    expect(ids(visibleThreads(projects, threads, "project", {}))).toEqual(["t1", "t3", "t2"])
    expect(ids(visibleThreads(projects, threads, "project", { p1: false }))).toEqual(["t2"])
    expect(ids(visibleThreads(projects, threads, "time", { p1: false }))).toEqual([
      "t2",
      "t3",
      "t1",
    ])
  })
})

describe("WorkspaceSidebar", () => {
  it("shows schedules and plugins next to new chat, and a single add-project row when empty", () => {
    const onOpenSchedules = vi.fn()
    const onOpenPlugins = vi.fn()
    const onAddProject = vi.fn()
    render(
      <LocaleProvider locale="zh-CN">
        <WorkspaceSidebar
          projects={[]}
          threads={[]}
          activeThreadId={null}
          expandedProjects={{}}
          onAddProject={onAddProject}
          onToggleProject={() => {}}
          onOpenThread={() => {}}
          onNewThread={() => {}}
          onOpenSchedules={onOpenSchedules}
          onOpenPlugins={onOpenPlugins}
        />
      </LocaleProvider>,
    )
    fireEvent.click(screen.getByRole("button", { name: "定时任务" }))
    fireEvent.click(screen.getByRole("button", { name: "插件" }))
    expect(onOpenSchedules).toHaveBeenCalledTimes(1)
    expect(onOpenPlugins).toHaveBeenCalledTimes(1)
    const addButtons = screen.getAllByRole("button", { name: "添加项目" })
    expect(addButtons).toHaveLength(2)
    fireEvent.click(addButtons[1] as HTMLElement)
    expect(onAddProject).toHaveBeenCalledTimes(1)
  })

  it("switches to a single list sorted by time from the filter menu and remembers it", async () => {
    window.localStorage.removeItem("pigcode.sidebarGrouping")
    render(
      <LocaleProvider locale="zh-CN">
        <WorkspaceSidebar
          projects={[project("p1", "alpha"), project("p2", "beta")]}
          threads={[
            thread("t1", "p1", "older", "2026-10-20T01:00:00.000Z"),
            thread("t2", "p2", "newest", "2026-10-20T03:00:00.000Z"),
            thread("t3", "p1", "middle", "2026-10-20T02:00:00.000Z"),
            thread("t4", "gone", "hidden", "2026-10-20T04:00:00.000Z"),
          ]}
          activeThreadId={null}
          expandedProjects={{}}
          onAddProject={() => {}}
          onToggleProject={() => {}}
          onOpenThread={() => {}}
          onNewThread={() => {}}
        />
      </LocaleProvider>,
    )
    const titles = () =>
      Array.from(document.querySelectorAll(".sess-title")).map((node) => node.textContent)
    expect(titles()).toEqual(["older", "middle", "newest"])

    await userEvent.click(screen.getByRole("button", { name: "会话排列方式" }))
    await userEvent.click(await screen.findByRole("menuitem", { name: "按时间" }))
    expect(titles()).toEqual(["newest", "middle", "older"])
    expect(screen.getByText("最近会话")).toBeTruthy()
    expect(
      Array.from(document.querySelectorAll(".sess-project")).map((node) => node.textContent),
    ).toEqual(["beta", "alpha", "alpha"])
    expect(window.localStorage.getItem("pigcode.sidebarGrouping")).toBe("time")
    window.localStorage.removeItem("pigcode.sidebarGrouping")
  })

  it("animates a dot matrix for running threads and keeps a status dot for the rest", () => {
    renderSidebar({
      threads: [
        thread("t1", "p1", "Running thread", "2026-10-20T01:00:00.000Z"),
        thread("t2", "p1", "Finished thread", "2026-10-20T00:30:00.000Z"),
      ],
      threadStatus: { t1: "running", t2: "completed" },
    })
    const running = screen.getByRole("button", { name: /Running thread/ })
    expect(running.querySelector(".sess-indicator .dot-matrix")).not.toBeNull()
    expect(running.querySelectorAll(".dot-matrix-cell")).toHaveLength(9)
    expect(running.querySelector(".sess-dot")).toBeNull()
    expect(running.textContent).toContain("运行中")
    const finished = screen.getByRole("button", { name: /Finished thread/ })
    expect(finished.querySelector(".dot-matrix")).toBeNull()
    expect(finished.querySelector(".sess-dot")?.getAttribute("data-status")).toBe("completed")
    // 长标题靠渐隐收尾，完整标题放在 title 上。
    expect(running.querySelector(".sess-title")?.getAttribute("title")).toBe("Running thread")
  })

  it("keeps relative times current by refreshing them every minute", () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date("2026-10-21T08:00:30.000Z"))
    try {
      renderSidebar({ threads: [thread("t1", "p1", "Fresh thread", "2026-10-21T08:00:00.000Z")] })
      expect(document.querySelector(".sess time")?.textContent).toBe("刚刚")
      act(() => {
        vi.advanceTimersByTime(3 * 60_000)
      })
      expect(document.querySelector(".sess time")?.textContent).toBe("3分钟")
    } finally {
      vi.useRealTimers()
    }
  })

  it("renders projects and threads", () => {
    render(
      <LocaleProvider locale="zh-CN">
        <WorkspaceSidebar
          projects={[
            {
              id: "p1",
              rootPath: "/tmp/demo",
              name: "demo",
              createdAt: "2026-10-20T00:00:00.000Z",
            },
          ]}
          threads={[
            {
              id: "t1",
              projectId: "p1",
              title: "First thread",
              defaultAgentId: "fake",
              lastAgentId: null,
              lastModelId: null,
              permissionMode: "workspace-write",
              createdAt: "2026-10-20T00:00:00.000Z",
              updatedAt: "2026-10-20T00:00:00.000Z",
              archivedAt: null,
              lastRunId: null,
            },
          ]}
          activeThreadId="t1"
          expandedProjects={{ p1: true }}
          onAddProject={() => {}}
          onToggleProject={() => {}}
          onOpenThread={() => {}}
          onNewThread={() => {}}
          onOpenSettings={() => {}}
        />
      </LocaleProvider>,
    )
    expect(screen.getByText("demo")).toBeTruthy()
    expect(screen.getByText("First thread")).toBeTruthy()
  })

  it("renames a thread in place from its context menu", async () => {
    const onRenameThread = vi.fn()
    renderSidebar({ onRenameThread, onArchiveThread: vi.fn() })

    fireEvent.contextMenu(screen.getByRole("button", { name: /First thread/ }))
    await userEvent.click(await screen.findByRole("menuitem", { name: "重命名" }))
    const input = await screen.findByRole("textbox", { name: "会话名称" })
    expect(document.activeElement).toBe(input)
    await userEvent.clear(input)
    await userEvent.type(input, "  Renamed  {Enter}")

    expect(onRenameThread).toHaveBeenCalledExactlyOnceWith("t1", "Renamed")
    expect(screen.queryByRole("textbox")).toBeNull()
    expect(screen.getByRole("button", { name: /First thread/ })).toBeTruthy()
  })

  it("leaves the title alone on Escape, on an unchanged or empty name", async () => {
    const onRenameThread = vi.fn()
    renderSidebar({ onRenameThread, onArchiveThread: vi.fn() })
    const startRename = async () => {
      fireEvent.contextMenu(screen.getByRole("button", { name: /First thread/ }))
      await userEvent.click(await screen.findByRole("menuitem", { name: "重命名" }))
      return screen.findByRole("textbox", { name: "会话名称" })
    }

    await userEvent.type(await startRename(), "changed{Escape}")
    await userEvent.type(await startRename(), "{Enter}")
    const input = await startRename()
    await userEvent.clear(input)
    fireEvent.blur(input)

    expect(onRenameThread).not.toHaveBeenCalled()
    expect(screen.queryByRole("textbox")).toBeNull()
  })

  it("archives a thread from its context menu", async () => {
    const onArchiveThread = vi.fn()
    renderSidebar({ onRenameThread: vi.fn(), onArchiveThread })

    fireEvent.contextMenu(screen.getByRole("button", { name: /First thread/ }))
    await userEvent.click(await screen.findByRole("menuitem", { name: "归档" }))

    expect(onArchiveThread).toHaveBeenCalledExactlyOnceWith("t1")
  })

  it("has no context menu when renaming and archiving are not wired", () => {
    renderSidebar()

    fireEvent.contextMenu(screen.getByRole("button", { name: /First thread/ }))
    fireEvent.contextMenu(screen.getByRole("button", { name: "alpha" }))
    expect(screen.queryByRole("menu")).toBeNull()
  })

  it("renames a project, opens its folder and removes it from the project's context menu", async () => {
    const openFolder = vi.fn().mockResolvedValue(undefined)
    mockNative({ platform: "linux", openFolder })
    const onRenameProject = vi.fn()
    const onRemoveProject = vi.fn()
    renderSidebar({ onRenameProject, onRemoveProject })
    const openMenu = () => fireEvent.contextMenu(screen.getByRole("button", { name: "alpha" }))

    openMenu()
    await userEvent.click(await screen.findByRole("menuitem", { name: "在文件管理器中打开" }))
    expect(openFolder).toHaveBeenCalledExactlyOnceWith("/tmp/alpha")

    openMenu()
    await userEvent.click(await screen.findByRole("menuitem", { name: "重命名" }))
    const input = await screen.findByRole("textbox", { name: "项目名称" })
    expect(document.activeElement).toBe(input)
    await userEvent.clear(input)
    await userEvent.type(input, "客户门户{Enter}")
    expect(onRenameProject).toHaveBeenCalledExactlyOnceWith("p1", "客户门户")

    openMenu()
    await userEvent.click(await screen.findByRole("menuitem", { name: "从侧栏移除" }))
    expect(onRemoveProject).toHaveBeenCalledExactlyOnceWith("p1")
    expect(screen.getByText("已移除「alpha」，再次添加这个文件夹即可恢复")).toBeTruthy()
  })

  it("says so when the project folder can't be opened, naming it after the platform's file manager", async () => {
    mockNative({
      platform: "darwin",
      openFolder: vi.fn().mockRejectedValue(new Error("FOLDER_NOT_FOUND")),
    })
    renderSidebar({ onRenameProject: vi.fn(), onRemoveProject: vi.fn() })

    fireEvent.contextMenu(screen.getByRole("button", { name: "alpha" }))
    await userEvent.click(await screen.findByRole("menuitem", { name: "在访达中打开" }))
    expect(await screen.findByText("无法打开文件夹 /tmp/alpha")).toBeTruthy()
  })

  it("shows Ctrl+1…9 on the first nine visible threads instead of their time", () => {
    const threads = Array.from({ length: 10 }, (_, index) =>
      thread(`t${index}`, "p1", `Thread ${index}`, "2026-10-20T01:00:00.000Z"),
    )
    const { rerender } = renderSidebar({ threads, shortcutHints: true })
    const badges = () =>
      Array.from(document.querySelectorAll(".sess-kbd")).map((node) => node.textContent)

    expect(badges()).toEqual([
      "Ctrl+1",
      "Ctrl+2",
      "Ctrl+3",
      "Ctrl+4",
      "Ctrl+5",
      "Ctrl+6",
      "Ctrl+7",
      "Ctrl+8",
      "Ctrl+9",
    ])
    expect(document.querySelectorAll(".sess time")).toHaveLength(1)

    rerender(
      <LocaleProvider locale="zh-CN">
        <WorkspaceSidebar
          projects={[project("p1", "alpha")]}
          threads={threads}
          activeThreadId={null}
          expandedProjects={{}}
          onAddProject={() => {}}
          onToggleProject={() => {}}
          onOpenThread={() => {}}
          onNewThread={() => {}}
        />
      </LocaleProvider>,
    )
    expect(badges()).toEqual([])
    expect(document.querySelectorAll(".sess time")).toHaveLength(10)
  })
})
