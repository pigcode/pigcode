/** 验证侧栏渲染导航、项目与会话，会话的右键菜单、数字快捷键与项目的拖动排序。 */
// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { afterEach, describe, expect, it, vi } from "vitest"
import { LocaleProvider } from "@pigcode/ui-primitives"
import { chooseMenuItem, mockMenu, project, renderSidebar, thread } from "./sidebar.fixtures"
import { PROJECT_DRAG_TYPE } from "./sidebar-rows"
import { WorkspaceSidebar } from "./workspace-sidebar"

afterEach(() => {
  cleanup()
  window.localStorage.removeItem("pigcode.sidebarGrouping")
  window.localStorage.removeItem("pigcode.sidebarView")
})

afterEach(() => {
  Reflect.deleteProperty(window, "pigcodeNative")
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
    expect(screen.getByRole("button", { name: "插件" }).getAttribute("aria-current")).toBeNull()
    expect(screen.getByRole("button", { name: "定时任务" }).getAttribute("aria-current")).toBeNull()
    const addButtons = screen.getAllByRole("button", { name: "添加项目" })
    expect(addButtons).toHaveLength(2)
    fireEvent.click(addButtons[1] as HTMLElement)
    expect(onAddProject).toHaveBeenCalledTimes(1)
  })

  it("pins the main navigation above the scrolling list, which ends with the extra content", () => {
    renderSidebar({ onOpenSchedules: vi.fn(), onOpenPlugins: vi.fn(), children: <p>panel body</p> })
    const head = document.querySelector(".side-head") as HTMLElement
    const list = document.querySelector(".side-scroll") as HTMLElement
    for (const name of ["新会话", "定时任务", "插件"]) {
      expect(within(head).getByRole("button", { name })).toBeTruthy()
    }
    expect(within(list).queryByRole("button", { name: "定时任务" })).toBeNull()
    expect(within(list).getByText("项目")).toBeTruthy()
    expect(within(list).getByRole("button", { name: /First thread/ })).toBeTruthy()
    expect(list.querySelector(".side-scroll-body")?.lastElementChild?.textContent).toBe(
      "panel body",
    )
  })

  it("reorders projects by dragging or from their menu and switches to the manual order", async () => {
    const menu = mockMenu()
    renderSidebar({
      projects: [project("p1", "alpha"), project("p2", "beta"), project("p3", "gamma")],
      threads: [],
      onRenameProject: vi.fn(),
      onRemoveProject: vi.fn(),
    })
    const names = () =>
      Array.from(document.querySelectorAll(".proj-row .list-row-title")).map(
        (node) => node.textContent,
      )
    const row = (name: string) => screen.getByRole("button", { name }).closest(".proj-row")!
    const block = (name: string) => row(name).closest(".proj-block")!
    const dataTransfer = {
      types: [PROJECT_DRAG_TYPE],
      getData: (type: string) => (type === PROJECT_DRAG_TYPE ? "p3" : ""),
      setData: vi.fn(),
      effectAllowed: "",
      dropEffect: "",
    }

    fireEvent.dragStart(row("gamma"), { dataTransfer })
    expect(block("gamma").hasAttribute("data-dragging")).toBe(true)
    fireEvent.dragOver(block("alpha"), { dataTransfer })
    expect(block("alpha").getAttribute("data-drop")).toBe("before")
    fireEvent.drop(block("alpha"), { dataTransfer })
    expect(names()).toEqual(["gamma", "alpha", "beta"])
    expect(JSON.parse(window.localStorage.getItem("pigcode.sidebarView") ?? "{}")).toMatchObject({
      projectOrder: "manual",
      projectIds: ["p3", "p1", "p2"],
    })
    // 拖进来的文件不当成调整顺序。
    fireEvent.dragOver(block("beta"), { dataTransfer: { ...dataTransfer, types: ["Files"] } })
    expect(block("beta").hasAttribute("data-drop")).toBe(false)

    await chooseMenuItem(menu, screen.getByRole("button", { name: "alpha" }), "move-up")
    expect(menu.mock.lastCall?.[0]).toEqual(
      expect.arrayContaining([
        { type: "separator" },
        { id: "move-up", label: "上移" },
        { id: "move-down", label: "下移" },
      ]),
    )
    expect(names()).toEqual(["alpha", "gamma", "beta"])
    // 最上面的项目没有「上移」。
    await chooseMenuItem(menu, screen.getByRole("button", { name: "alpha" }), "move-down")
    expect(menu.mock.lastCall?.[0]).not.toContainEqual(expect.objectContaining({ id: "move-up" }))
    expect(names()).toEqual(["gamma", "alpha", "beta"])
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
              defaultInstanceId: null,
              lastAgentId: null,
              lastInstanceId: null,
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
    const menu = mockMenu()
    const onRenameThread = vi.fn()
    renderSidebar({ onRenameThread, onArchiveThread: vi.fn() })

    await chooseMenuItem(menu, screen.getByRole("button", { name: /First thread/ }), "rename")
    const input = await screen.findByRole("textbox", { name: "会话名字" })
    expect(document.activeElement).toBe(input)
    await userEvent.clear(input)
    await userEvent.type(input, "  Renamed  {Enter}")

    expect(onRenameThread).toHaveBeenCalledExactlyOnceWith("t1", "Renamed")
    expect(screen.queryByRole("textbox")).toBeNull()
    expect(screen.getByRole("button", { name: /First thread/ })).toBeTruthy()
  })

  it("leaves the title alone on Escape, on an unchanged or empty name", async () => {
    const menu = mockMenu()
    const onRenameThread = vi.fn()
    renderSidebar({ onRenameThread, onArchiveThread: vi.fn() })
    const startRename = async () => {
      await chooseMenuItem(menu, screen.getByRole("button", { name: /First thread/ }), "rename")
      return screen.findByRole("textbox", { name: "会话名字" })
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
    const menu = mockMenu()
    const onArchiveThread = vi.fn()
    renderSidebar({ onRenameThread: vi.fn(), onArchiveThread })

    await chooseMenuItem(menu, screen.getByRole("button", { name: /First thread/ }), "archive")

    expect(onArchiveThread).toHaveBeenCalledExactlyOnceWith("t1")
  })

  it("mentions a thread in the composer from its context menu, but not the open one", async () => {
    const menu = mockMenu()
    const onReferenceThread = vi.fn()
    renderSidebar({ onRenameThread: vi.fn(), onArchiveThread: vi.fn(), onReferenceThread })

    await chooseMenuItem(menu, screen.getByRole("button", { name: /First thread/ }), "reference")
    expect(onReferenceThread).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ id: "t1", title: "First thread" }),
    )
    cleanup()

    renderSidebar({
      onRenameThread: vi.fn(),
      onArchiveThread: vi.fn(),
      onReferenceThread,
      activeThreadId: "t1",
    })
    await act(async () => {
      fireEvent.contextMenu(screen.getByRole("button", { name: /First thread/ }))
    })
    expect(menu).toHaveBeenCalledTimes(2)
    expect(menu.mock.lastCall?.[0]).not.toContainEqual(expect.objectContaining({ id: "reference" }))
  })

  it("has no context menu when renaming and archiving are not wired", () => {
    const menu = mockMenu()
    renderSidebar()

    fireEvent.contextMenu(screen.getByRole("button", { name: /First thread/ }))
    fireEvent.contextMenu(screen.getByRole("button", { name: "alpha" }))
    expect(menu).not.toHaveBeenCalled()
  })

  it("renames a project, opens its folder and removes it from the project's context menu", async () => {
    const openFolder = vi.fn().mockResolvedValue(undefined)
    const menu = mockMenu({ openFolder })
    const onRenameProject = vi.fn()
    const onRemoveProject = vi.fn()
    renderSidebar({ onRenameProject, onRemoveProject })
    const choose = (id: string) =>
      chooseMenuItem(menu, screen.getByRole("button", { name: "alpha" }), id)

    await choose("open-folder")
    expect(openFolder).toHaveBeenCalledExactlyOnceWith("/tmp/alpha")

    await choose("rename")
    const input = await screen.findByRole("textbox", { name: "项目名字" })
    expect(document.activeElement).toBe(input)
    await userEvent.clear(input)
    await userEvent.type(input, "客户门户{Enter}")
    expect(onRenameProject).toHaveBeenCalledExactlyOnceWith("p1", "客户门户")

    await choose("remove")
    expect(onRemoveProject).toHaveBeenCalledExactlyOnceWith("p1")
    expect(screen.getByText("已移除「alpha」，再添加这个文件夹就回来了")).toBeTruthy()
  })

  it("keeps only new chat on the project row and puts browsing files first in its menu, like Cursor", async () => {
    const menu = mockMenu()
    const onBrowseFiles = vi.fn()
    renderSidebar({ onBrowseFiles, onRenameProject: vi.fn(), onRemoveProject: vi.fn() })
    const projectRow = screen.getByRole("button", { name: "alpha" }).closest(".proj-row")!
    expect(
      Array.from(projectRow.querySelectorAll(".list-row-actions button")).map((button) =>
        button.getAttribute("aria-label"),
      ),
    ).toEqual(["新会话"])

    await chooseMenuItem(menu, screen.getByRole("button", { name: "alpha" }), "browse-files")
    expect(menu.mock.lastCall?.[0].map((item) => ("id" in item ? item.label : "—"))).toEqual([
      "查看文件",
      "在文件管理器中打开",
      "重命名",
      "—",
      "从侧栏移除",
    ])
    expect(onBrowseFiles).toHaveBeenCalledExactlyOnceWith("p1")
  })

  it("says so when the project folder can't be opened, naming it after the platform's file manager", async () => {
    const menu = mockMenu({
      platform: "darwin",
      openFolder: vi.fn().mockRejectedValue(new Error("FOLDER_NOT_FOUND")),
    })
    renderSidebar({ onRenameProject: vi.fn(), onRemoveProject: vi.fn() })

    await chooseMenuItem(menu, screen.getByRole("button", { name: "alpha" }), "open-folder")
    expect(menu.mock.lastCall?.[0]).toContainEqual({ id: "open-folder", label: "在访达中打开" })
    expect(await screen.findByText("打不开文件夹 /tmp/alpha")).toBeTruthy()
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
