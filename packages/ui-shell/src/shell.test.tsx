/** 验证外壳：平台标题栏与菜单、工作区、右栏的收起与最大化、底部抽屉与快捷键。 */
// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react"
import type { ComponentProps } from "react"
import { afterEach, describe, expect, it, vi } from "vitest"
import { ExtensionRegistryScope, createExtensionRegistry } from "@pigcode/client-runtime"
import { LocaleProvider } from "@pigcode/ui-primitives"
import { Shell } from "./shell"

/** 用替身代替 preload 暴露的原生桥。 */
function mockNative(value: Partial<NonNullable<Window["pigcodeNative"]>>): void {
  Object.defineProperty(window, "pigcodeNative", { configurable: true, value })
}

// vitest 未开启 globals，Testing Library 不会自动清理，多测试用例需要手动卸载。
afterEach(() => {
  cleanup()
  Reflect.deleteProperty(window, "pigcodeNative")
  delete document.documentElement.dataset.platform
  delete document.documentElement.dataset.fullscreen
})

function renderShell(props: Partial<ComponentProps<typeof Shell>> = {}) {
  return render(
    <LocaleProvider locale="zh-CN">
      <Shell
        view="chat"
        projects={[]}
        threads={[]}
        activeThreadId={null}
        onView={() => {}}
        onAddProject={() => {}}
        onNewThread={() => {}}
        onOpenThread={() => {}}
        rightPanel={<div>right</div>}
        {...props}
      >
        <div>chat</div>
      </Shell>
    </LocaleProvider>,
  )
}

describe("Shell", () => {
  it("draws the title bar menus on Linux and runs the command picked from the native menu", async () => {
    const popupMenu = vi.fn().mockResolvedValue("new-thread")
    mockNative({ platform: "linux", popupMenu })
    const onNewThread = vi.fn()
    renderShell({ onNewThread })

    expect(document.documentElement.dataset.platform).toBe("linux")
    expect(screen.getByRole("navigation", { name: "应用菜单" })).toBeTruthy()
    fireEvent.click(screen.getByRole("button", { name: "文件" }))
    await waitFor(() => expect(onNewThread).toHaveBeenCalledTimes(1))
    const [items, position] = popupMenu.mock.calls[0] ?? []
    expect(items[0]).toEqual({ id: "new-thread", label: "新会话", accelerator: "CmdOrCtrl+N" })
    expect(items).toContainEqual({ role: "quit", label: "退出" })
    expect(position).toEqual({ x: expect.any(Number), y: expect.any(Number) })
  })

  it("does nothing when the native menu closes without a choice", async () => {
    const popupMenu = vi.fn().mockResolvedValue(null)
    mockNative({ platform: "win32", popupMenu })
    const onView = vi.fn()
    renderShell({ onView })

    fireEvent.click(screen.getByRole("button", { name: "帮助" }))
    await waitFor(() => expect(popupMenu).toHaveBeenCalledTimes(1))
    expect(screen.getByRole("button", { name: "帮助" }).getAttribute("aria-expanded")).toBe("false")
    expect(onView).not.toHaveBeenCalled()
  })

  it("leaves the window buttons to macOS and draws no title bar or fake traffic lights", () => {
    mockNative({ platform: "darwin" })
    const { container } = renderShell()

    expect(document.documentElement.dataset.platform).toBe("darwin")
    expect(screen.queryByRole("navigation", { name: "应用菜单" })).toBeNull()
    expect(container.querySelector(".traffic")).toBeNull()
  })

  it("marks full screen so macOS can drop the traffic light inset", async () => {
    let listener: ((fullScreen: boolean) => void) | undefined
    mockNative({
      platform: "darwin",
      isFullScreen: () => Promise.resolve(false),
      onFullScreenChange: (next) => {
        listener = next
        return () => undefined
      },
    })
    renderShell()

    await waitFor(() => expect(listener).toBeDefined())
    act(() => listener?.(true))
    expect(document.documentElement.dataset.fullscreen).toBe("true")
    act(() => listener?.(false))
    expect(document.documentElement.dataset.fullscreen).toBeUndefined()
  })

  it("opens the sidebar as a drawer in narrow windows and closes it from the scrim or Esc", () => {
    Object.defineProperty(window, "matchMedia", {
      configurable: true,
      value: (query: string) => ({
        matches: query === "(max-width: 960px)",
        addEventListener: () => undefined,
        removeEventListener: () => undefined,
      }),
    })
    try {
      const { container } = renderShell()
      const app = container.querySelector(".app")

      fireEvent.click(screen.getByRole("button", { name: "展开侧栏" }))
      expect(app?.classList.contains("is-drawer-open")).toBe(true)
      expect(app?.classList.contains("is-collapsed")).toBe(false)
      fireEvent.click(container.querySelector(".drawer-scrim") as HTMLElement)
      expect(app?.classList.contains("is-drawer-open")).toBe(false)

      fireEvent.keyDown(window, { key: "b", ctrlKey: true })
      expect(app?.classList.contains("is-drawer-open")).toBe(true)
      fireEvent.keyDown(window, { key: "Escape" })
      expect(app?.classList.contains("is-drawer-open")).toBe(false)
    } finally {
      Reflect.deleteProperty(window, "matchMedia")
    }
  })

  it("goes back and forward with Alt+arrows, the buttons and mouse side buttons", () => {
    const onBack = vi.fn()
    const onForward = vi.fn()
    renderShell({ canGoBack: true, canGoForward: true, onBack, onForward })

    fireEvent.keyDown(window, { key: "ArrowLeft", altKey: true })
    fireEvent.keyDown(window, { key: "ArrowRight", altKey: true })
    fireEvent.click(screen.getByRole("button", { name: "后退" }))
    fireEvent.mouseUp(window, { button: 4 })
    expect(onBack).toHaveBeenCalledTimes(2)
    expect(onForward).toHaveBeenCalledTimes(2)

    // 输入框里的 Alt+方向键留给文本编辑。
    const input = document.createElement("input")
    document.body.append(input)
    fireEvent.keyDown(input, { key: "ArrowLeft", altKey: true })
    input.remove()
    expect(onBack).toHaveBeenCalledTimes(2)
  })

  it("uses ⌘[ and ⌘] for history on macOS", () => {
    mockNative({ platform: "darwin" })
    const onBack = vi.fn()
    const onForward = vi.fn()
    renderShell({ canGoBack: true, onBack, onForward })

    fireEvent.keyDown(window, { key: "[", metaKey: true })
    fireEvent.keyDown(window, { key: "]", metaKey: true })
    fireEvent.keyDown(window, { key: "ArrowLeft", altKey: true })
    expect(onBack).toHaveBeenCalledTimes(1)
    expect(onForward).toHaveBeenCalledTimes(1)
    expect(screen.getByRole("button", { name: "后退" }).getAttribute("title")).toBe("后退 ⌘[")
  })

  it("opens the command palette from the search button in the sidebar's top row", () => {
    renderShell()

    fireEvent.click(screen.getByRole("button", { name: "搜索" }))
    expect(screen.getByRole("dialog", { name: "行动" })).toBeTruthy()
  })

  it("does not open the command palette over an open dialog", () => {
    renderShell()
    const dialog = document.createElement("div")
    dialog.className = "dialog"
    document.body.append(dialog)

    fireEvent.keyDown(window, { key: "k", metaKey: true })
    expect(screen.queryByRole("dialog", { name: "行动" })).toBeNull()

    dialog.remove()
    fireEvent.keyDown(window, { key: "k", metaKey: true })
    expect(screen.getByRole("dialog", { name: "行动" })).toBeTruthy()
  })

  it("places chat and the right panel side by side in the workspace", () => {
    const { container } = renderShell()

    const workspace = container.querySelector(".workspace")
    expect(workspace?.querySelector("main.panel")?.textContent).toContain("chat")
    expect(workspace?.querySelector(".right-panel-slot")?.textContent).toContain("right")
    expect(screen.getByRole("separator", { name: "右侧面板" })).toBeTruthy()
    expect(container.querySelector(".app")?.classList.contains("has-right")).toBe(true)
  })

  it("resizes the right panel from its separator and remembers the width", () => {
    window.localStorage.removeItem("pigcode.rightWidth")
    const { container } = renderShell()
    const app = container.querySelector(".app") as HTMLElement
    const separator = screen.getByRole("separator", { name: "右侧面板" })

    expect(app.style.getPropertyValue("--right-w")).toBe("460px")
    fireEvent.keyDown(separator, { key: "ArrowLeft" })
    expect(app.style.getPropertyValue("--right-w")).toBe("484px")
    expect(window.localStorage.getItem("pigcode.rightWidth")).toBe("484")
    fireEvent.doubleClick(separator)
    expect(app.style.getPropertyValue("--right-w")).toBe("460px")
  })

  it("keeps the right panel mounted but hidden when closed", () => {
    const { container } = renderShell({ rightOpen: false })

    const slot = container.querySelector(".right-panel-slot")
    expect(slot?.hasAttribute("hidden")).toBe(true)
    expect(slot?.textContent).toContain("right")
    expect(screen.queryByRole("separator", { name: "右侧面板" })).toBeNull()
    expect(container.querySelector(".app")?.classList.contains("has-right")).toBe(false)
  })

  it("maximizes the right panel without a resizer", () => {
    const { container } = renderShell({ rightMaximized: true })

    expect(container.querySelector(".app")?.classList.contains("is-right-max")).toBe(true)
    expect(screen.queryByRole("separator", { name: "右侧面板" })).toBeNull()
  })

  it("renders the bottom panel under the chat and toggles it with Ctrl+`", () => {
    const onToggleTerminal = vi.fn()
    const { container } = renderShell({
      bottomPanel: <div>drawer</div>,
      onToggleTerminal,
    })

    expect(container.querySelector("main.panel")?.textContent).toBe("chatdrawer")
    fireEvent.keyDown(window, { key: "`", code: "Backquote", ctrlKey: true })
    expect(onToggleTerminal).toHaveBeenCalledTimes(1)
  })

  it("toggles the right panel with ⌘J", () => {
    const onToggleRight = vi.fn()
    renderShell({ onToggleRight })

    fireEvent.keyDown(window, { key: "j", metaKey: true })
    expect(onToggleRight).toHaveBeenCalledTimes(1)
  })

  describe("thread shortcuts", () => {
    const projects = [
      { id: "p1", rootPath: "/tmp/alpha", name: "alpha", createdAt: "2026-10-20T00:00:00.000Z" },
    ]
    const threads = ["t1", "t2", "t3"].map((id, index) => ({
      id,
      projectId: "p1",
      title: `Thread ${index + 1}`,
      defaultAgentId: "fake",
      lastAgentId: null,
      lastModelId: null,
      permissionMode: "workspace-write" as const,
      createdAt: "2026-10-20T00:00:00.000Z",
      updatedAt: `2026-10-20T0${index}:00:00.000Z`,
      archivedAt: null,
      lastRunId: null,
    }))
    const badges = () =>
      Array.from(document.querySelectorAll(".sess-kbd")).map((node) => node.textContent)

    afterEach(() => {
      vi.useRealTimers()
    })

    it("shows the numbers while Ctrl is held and opens the n-th thread with Ctrl+n", () => {
      vi.useFakeTimers()
      const onOpenThread = vi.fn()
      const { container } = renderShell({ projects, threads, onOpenThread })

      fireEvent.keyDown(window, { key: "Control", code: "ControlLeft", ctrlKey: true })
      expect(badges()).toEqual([])
      act(() => vi.advanceTimersByTime(500))
      expect(badges()).toEqual(["Ctrl+1", "Ctrl+2", "Ctrl+3"])
      expect(container.querySelector(".sidebar")?.classList.contains("show-shortcuts")).toBe(true)

      fireEvent.keyDown(window, { key: "2", code: "Digit2", ctrlKey: true })
      expect(onOpenThread).toHaveBeenCalledExactlyOnceWith("t2")
      expect(badges()).toHaveLength(3)
      fireEvent.keyDown(window, { key: "9", code: "Digit9", ctrlKey: true })
      expect(onOpenThread).toHaveBeenCalledTimes(1)

      fireEvent.keyUp(window, { key: "Control", code: "ControlLeft" })
      expect(badges()).toEqual([])
    })

    it("follows the time order when the sidebar is arranged by time", () => {
      window.localStorage.setItem("pigcode.sidebarGrouping", "time")
      try {
        const onOpenThread = vi.fn()
        renderShell({ projects, threads, onOpenThread })
        fireEvent.keyDown(window, { key: "1", code: "Digit1", ctrlKey: true })
        expect(onOpenThread).toHaveBeenCalledExactlyOnceWith("t3")
      } finally {
        window.localStorage.removeItem("pigcode.sidebarGrouping")
      }
    })

    it("uses ⌘ on macOS and does not flash the numbers for a quick ⌘K", () => {
      vi.useFakeTimers()
      mockNative({ platform: "darwin" })
      const onOpenThread = vi.fn()
      renderShell({ projects, threads, onOpenThread })

      fireEvent.keyDown(window, { key: "1", code: "Digit1", ctrlKey: true })
      expect(onOpenThread).not.toHaveBeenCalled()
      fireEvent.keyDown(window, { key: "3", code: "Digit3", metaKey: true })
      expect(onOpenThread).toHaveBeenCalledExactlyOnceWith("t3")

      fireEvent.keyDown(window, { key: "Meta", code: "MetaLeft", metaKey: true })
      fireEvent.keyDown(window, { key: "k", code: "KeyK", metaKey: true })
      act(() => vi.advanceTimersByTime(500))
      expect(badges()).toEqual([])
    })

    it("leaves Ctrl+number alone in settings", () => {
      const onOpenThread = vi.fn()
      renderShell({ view: "settings", projects, threads, onOpenThread })
      fireEvent.keyDown(window, { key: "1", code: "Digit1", ctrlKey: true })
      expect(onOpenThread).not.toHaveBeenCalled()
    })
  })

  it("draws the Panels registered on the extension point in the sidebar, in order, and drops removed ones", () => {
    const registry = createExtensionRegistry()
    const owner = { kind: "plugin", id: "ui.demo" } as const
    registry.register("panel", {
      id: "b",
      owner,
      order: 0,
      title: { text: "Second" },
      render: () => <p>second body</p>,
    })
    registry.register("panel", {
      id: "a",
      owner,
      order: 0,
      title: { text: "First" },
      render: () => <p>first body</p>,
    })
    render(
      <ExtensionRegistryScope registry={registry}>
        <LocaleProvider locale="zh-CN">
          <Shell
            view="chat"
            projects={[]}
            threads={[]}
            activeThreadId={null}
            onView={() => {}}
            onAddProject={() => {}}
            onNewThread={() => {}}
            onOpenThread={() => {}}
          />
        </LocaleProvider>
      </ExtensionRegistryScope>,
    )
    const group = screen.getByLabelText("插件管理")
    expect(group.closest(".side-scroll")).not.toBeNull()
    const heads = Array.from(group.querySelectorAll(".plugin-panel-head"))
    expect(heads.map((head) => head.textContent)).toEqual(["First", "Second"])
    expect(screen.getByText("first body")).toBeTruthy()

    fireEvent.click(screen.getByRole("button", { name: "First" }))
    expect(screen.queryByText("first body")).toBeNull()

    act(() => registry.removeOwner(owner))
    expect(screen.queryByLabelText("插件管理")).toBeNull()
  })

  it("keeps the workspace sidebar on the plugins and schedules pages, marking the open one", () => {
    const onView = vi.fn()
    const { rerender } = renderShell({ view: "plugins", onView })
    const plugins = () => screen.getByRole("button", { name: "插件" })
    const schedules = () => screen.getByRole("button", { name: "定时任务" })
    expect(plugins().getAttribute("aria-current")).toBe("page")
    expect(schedules().getAttribute("aria-current")).toBeNull()
    expect(screen.queryByRole("button", { name: "返回应用" })).toBeNull()
    expect(screen.getByRole("button", { name: "设置" })).toBeTruthy()
    fireEvent.click(schedules())
    expect(onView).toHaveBeenLastCalledWith("schedules")

    rerender(
      <LocaleProvider locale="zh-CN">
        <Shell
          view="schedules"
          projects={[]}
          threads={[]}
          activeThreadId={null}
          onView={onView}
          onAddProject={() => {}}
          onNewThread={() => {}}
          onOpenThread={() => {}}
        />
      </LocaleProvider>,
    )
    expect(schedules().getAttribute("aria-current")).toBe("page")
    expect(plugins().getAttribute("aria-current")).toBeNull()
    fireEvent.click(plugins())
    expect(onView).toHaveBeenLastCalledWith("plugins")
  })

  it("puts the built-in commands in the palette from the registry, before a plugin's", async () => {
    const registry = createExtensionRegistry()
    const onPlugin = vi.fn()
    const onNewThread = vi.fn()
    registry.register("command", {
      id: "plugin-run",
      owner: { kind: "plugin", id: "ui.demo" },
      order: 0,
      title: { text: "Run the sample command" },
      keywords: ["debug"],
      slash: "debug",
      run: onPlugin,
    })
    render(
      <ExtensionRegistryScope registry={registry}>
        <LocaleProvider locale="zh-CN">
          <Shell
            view="chat"
            projects={[]}
            threads={[]}
            activeThreadId={null}
            onView={() => {}}
            onAddProject={() => {}}
            onNewThread={onNewThread}
            onOpenThread={() => {}}
          />
        </LocaleProvider>
      </ExtensionRegistryScope>,
    )

    fireEvent.click(screen.getByRole("button", { name: "搜索" }))
    const dialog = screen.getByRole("dialog", { name: "行动" })
    const input = dialog.querySelector("input") as HTMLInputElement
    // 内置命令由 Shell 登记，order 小于 0；缺省 order 的插件命令排在它们后面。
    const labels = screen.getAllByRole("option").map((item) => item.textContent ?? "")
    expect(labels).toHaveLength(6)
    expect(labels[0]).toContain("新会话")
    expect(labels[5]).toContain("Run the sample command")
    // 空面板里回车执行的仍然是新会话。
    fireEvent.keyDown(input, { key: "Enter" })
    expect(onNewThread).toHaveBeenCalledTimes(1)
    expect(onPlugin).not.toHaveBeenCalled()

    fireEvent.click(screen.getByRole("button", { name: "搜索" }))
    fireEvent.change(screen.getByRole("dialog", { name: "行动" }).querySelector("input")!, {
      target: { value: "debug" },
    })
    fireEvent.click(screen.getByRole("option", { name: /Run the sample command/ }))
    expect(onPlugin).toHaveBeenCalledTimes(1)
  })

  it("registers the built-in commands once, not again on every render of its caller", () => {
    const registry = createExtensionRegistry()
    let changes = 0
    registry.subscribe("command", () => changes++)
    const calls: number[] = []
    const shell = (round: number) => (
      <ExtensionRegistryScope registry={registry}>
        <LocaleProvider locale="zh-CN">
          <Shell
            view="chat"
            projects={[]}
            threads={[]}
            activeThreadId={null}
            onView={() => {}}
            onAddProject={() => {}}
            // 调用方每次渲染都传新的回调，命令仍然调用最新的那个。
            onNewThread={() => calls.push(round)}
            onOpenThread={() => {}}
            onToggleRight={() => {}}
          />
        </LocaleProvider>
      </ExtensionRegistryScope>
    )
    const { rerender } = render(shell(1))
    const afterMount = changes
    rerender(shell(2))
    rerender(shell(3))

    expect(changes).toBe(afterMount)
    void registry
      .get("command")
      .find((command) => command.id === "new-thread")
      ?.run()
    expect(calls).toEqual([3])
  })
})
