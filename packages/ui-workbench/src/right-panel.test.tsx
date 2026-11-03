/** 验证右侧面板：surface 状态计算、标签切换与关闭、按扩展点生成的启动器与添加菜单及其快捷键。 */
// @vitest-environment jsdom
import { act, cleanup, fireEvent, render as renderUi, screen, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import type { ComponentProps, ReactElement } from "react"
import {
  FileDiff,
  Files,
  Globe,
  GitPullRequest,
  History,
  Puzzle,
  SquareTerminal,
} from "lucide-react"
import { afterEach, describe, expect, it, vi } from "vitest"
import {
  ExtensionRegistryScope,
  createExtensionRegistry,
  type ExtensionRegistry,
  type SurfaceContribution,
} from "@pigcode/client-runtime"
import { LocaleProvider, type MessageKey } from "@pigcode/ui-primitives"
import {
  EMPTY_SURFACE_STATE,
  RightPanel,
  addSurface,
  closeRemovedSurfaces,
  closeSurface,
  updateSurface,
  type PanelSurface,
} from "./right-panel"

const BUILTIN = { kind: "builtin", id: "workbench" } as const

/** 和应用里登记的六个内置 Surface 同样的名称、图标、顺序与快捷键；内容不在这里测。 */
function builtinSurface(
  id: string,
  key: MessageKey,
  icon: SurfaceContribution["icon"],
  shortcut: string,
  order: number,
  extra: Partial<SurfaceContribution> = {},
): SurfaceContribution {
  return { id, owner: BUILTIN, order, title: { key }, icon, shortcut, render: () => null, ...extra }
}

/** 登记了六个内置 Surface 的注册表；pr 可以标成不可用。 */
function workbenchRegistry(options: { prUnavailable?: MessageKey } = {}): ExtensionRegistry {
  const registry = createExtensionRegistry()
  const { prUnavailable } = options
  for (const surface of [
    builtinSurface("browser", "workbench.browser", Globe, "B", 10, { multiInstance: true }),
    builtinSurface("terminal", "workbench.terminal", SquareTerminal, "T", 20, {
      multiInstance: true,
    }),
    builtinSurface("files", "workbench.files", Files, "F", 30),
    builtinSurface("diff", "workbench.diff", FileDiff, "D", 40),
    builtinSurface(
      "pr",
      "workbench.pr",
      GitPullRequest,
      "P",
      50,
      prUnavailable ? { unavailable: () => prUnavailable } : {},
    ),
    builtinSurface("checkpoint", "workbench.checkpoint", History, "C", 60),
  ]) {
    registry.register("surface", surface)
  }
  return registry
}

/** 插件的 Surface：名称和说明是插件给的文字。 */
function pluginSurface(id: string, title: string, description?: string): SurfaceContribution {
  return {
    id,
    owner: { kind: "plugin", id: "pigcode-ui-debug-panel" },
    order: 0,
    title: { text: title },
    ...(description ? { description: { text: description } } : {}),
    icon: Puzzle,
    render: () => null,
  }
}

/** 组件文案来自 locale；测试按中文界面渲染，Surface 来自给定的注册表。 */
function render(ui: ReactElement, registry: ExtensionRegistry = workbenchRegistry()) {
  return renderUi(ui, {
    wrapper: ({ children }) => (
      <ExtensionRegistryScope registry={registry}>
        <LocaleProvider locale="zh-CN">{children}</LocaleProvider>
      </ExtensionRegistryScope>
    ),
  })
}

afterEach(() => cleanup())

const terminalTitle = (index: number): string => `终端 ${index}`

describe("surface state", () => {
  it("numbers multi-instance surfaces with the lowest free index", () => {
    const multi = { multiInstance: true }
    let state = addSurface(EMPTY_SURFACE_STATE, "terminal", "a", terminalTitle, multi)
    state = addSurface(state, "terminal", "b", terminalTitle, multi)
    state = closeSurface(state, "a")
    state = addSurface(state, "terminal", "c", terminalTitle, multi)

    expect(state.surfaces.map((surface) => surface.title)).toEqual(["终端 2", "终端 1"])
    expect(state.activeId).toBe("c")
  })

  it("activates an existing singleton instead of opening a duplicate", () => {
    let state = addSurface(EMPTY_SURFACE_STATE, "files", "f1", () => "文件")
    state = addSurface(state, "terminal", "t1", terminalTitle)
    state = addSurface(state, "files", "f2", () => "文件")

    expect(state.surfaces).toHaveLength(2)
    expect(state.activeId).toBe("f1")
  })

  it("activates the right neighbour, then the left one, when the active tab closes", () => {
    const multi = { multiInstance: true }
    let state = addSurface(EMPTY_SURFACE_STATE, "terminal", "a", terminalTitle, multi)
    state = addSurface(state, "terminal", "b", terminalTitle, multi)
    state = addSurface(state, "terminal", "c", terminalTitle, multi)
    state = { ...state, activeId: "b" }

    state = closeSurface(state, "b")
    expect(state.activeId).toBe("c")
    state = closeSurface(state, "c")
    expect(state.activeId).toBe("a")
    state = closeSurface(state, "a")
    expect(state).toEqual(EMPTY_SURFACE_STATE)
  })

  it("keeps the active tab when another one closes and updates in place", () => {
    let state = addSurface(EMPTY_SURFACE_STATE, "browser", "a", (i) => `浏览器 ${i}`)
    state = addSurface(state, "terminal", "b", terminalTitle)

    state = closeSurface(state, "a")
    expect(state.activeId).toBe("b")
    expect(updateSurface(state, "b", { title: "zsh" }).surfaces[0]?.title).toBe("zsh")
  })

  it("opens one tab per plugin surface and switches back to it", () => {
    let state = addSurface(EMPTY_SURFACE_STATE, "debug-inspector", "p1", () => "Debug Inspector")
    state = addSurface(state, "terminal", "t1", terminalTitle, { multiInstance: true })
    state = addSurface(state, "debug-inspector", "p2", () => "Debug Inspector")
    expect(state.surfaces).toEqual([
      { id: "p1", kind: "debug-inspector", title: "Debug Inspector" },
      { id: "t1", kind: "terminal", title: "终端 1" },
    ])
    expect(state.activeId).toBe("p1")
  })

  it("closes every tab of removed surfaces and moves the selection to a neighbour", () => {
    const state = {
      surfaces: [
        { id: "t1", kind: "terminal", title: "终端 1" },
        { id: "p1", kind: "debug-inspector", title: "Debug Inspector" },
        { id: "f1", kind: "file", title: "README.md", path: "README.md" },
        { id: "p2", kind: "other-plugin", title: "Other" },
      ],
      activeId: "p1",
    }
    const next = closeRemovedSurfaces(state, new Set(["debug-inspector", "other-plugin"]))
    expect(next.surfaces.map((surface) => surface.id)).toEqual(["t1", "f1"])
    expect(next.activeId).toBe("f1")
    expect(closeRemovedSurfaces(next, new Set(["debug-inspector"]))).toBe(next)
  })

  it("never closes file tabs, even if a surface with the file kind goes away", () => {
    const state = {
      surfaces: [{ id: "f1", kind: "file", title: "README.md", path: "README.md" }],
      activeId: "f1",
    }
    expect(closeRemovedSurfaces(state, new Set(["file"]))).toBe(state)
  })

  it("remembers the browser address next to its title", () => {
    const state = addSurface(EMPTY_SURFACE_STATE, "browser", "a", () => "浏览器")
    const next = updateSurface(state, "a", {
      title: "localhost:3000",
      url: "http://localhost:3000/",
    })

    expect(next.surfaces[0]).toEqual({
      id: "a",
      kind: "browser",
      title: "localhost:3000",
      url: "http://localhost:3000/",
    })
  })
})

const SURFACES: PanelSurface[] = [
  { id: "s1", kind: "browser", title: "localhost:3000" },
  { id: "s2", kind: "terminal", title: "终端 1" },
]

function renderPanel(
  props: Partial<ComponentProps<typeof RightPanel>> = {},
  registry?: ExtensionRegistry,
) {
  const handlers = { onActivate: vi.fn(), onClose: vi.fn(), onAdd: vi.fn() }
  render(
    <RightPanel threadId="t1" surfaces={SURFACES} activeId="s2" {...handlers} {...props}>
      <div>surface body</div>
    </RightPanel>,
    registry,
  )
  return handlers
}

describe("RightPanel", () => {
  it("renders tabs with the active one selected and switches on click", async () => {
    const { onActivate } = renderPanel()

    const tabs = screen.getAllByRole("tab")
    expect(tabs.map((tab) => tab.textContent)).toEqual(["localhost:3000", "终端 1"])
    expect(screen.getByRole("tab", { name: "终端 1" }).getAttribute("aria-selected")).toBe("true")
    expect(screen.getByText("surface body")).toBeTruthy()

    await userEvent.click(screen.getByRole("tab", { name: "localhost:3000" }))
    expect(onActivate).toHaveBeenCalledWith("s1")
  })

  it("closes a tab from its icon button or a middle click", async () => {
    const { onClose } = renderPanel()

    await userEvent.click(screen.getByRole("button", { name: "关闭 终端 1" }))
    expect(onClose).toHaveBeenCalledWith("s2")

    const browserTab = screen.getByRole("tab", { name: "localhost:3000" }).parentElement
    fireEvent(browserTab as HTMLElement, new MouseEvent("auxclick", { bubbles: true, button: 1 }))
    expect(onClose).toHaveBeenCalledWith("s1")
  })

  it("shows the launcher when no surface is active and opens one by click or letter", async () => {
    const { onAdd } = renderPanel(
      { surfaces: [], activeId: null },
      workbenchRegistry({ prUnavailable: "hostError.GH_NOT_AVAILABLE" }),
    )

    const launcher = screen.getByLabelText("打开一个面板")
    const pr = within(launcher).getByRole("button", { name: /PR/ }) as HTMLButtonElement
    expect(pr.disabled).toBe(true)
    expect(pr.title).toContain("gh")

    await userEvent.click(within(launcher).getByRole("button", { name: /文件/ }))
    expect(onAdd).toHaveBeenLastCalledWith("files")

    fireEvent.keyDown(window, { key: "t" })
    expect(onAdd).toHaveBeenLastCalledWith("terminal")

    onAdd.mockClear()
    fireEvent.keyDown(window, { key: "p" })
    fireEvent.keyDown(window, { key: "t", metaKey: true })
    expect(onAdd).not.toHaveBeenCalled()
  })

  it("ignores launcher letters while typing or while the panel is hidden", () => {
    const { onAdd } = renderPanel({ surfaces: [], activeId: null })
    const input = document.createElement("input")
    document.body.append(input)

    fireEvent.keyDown(input, { key: "b" })
    expect(onAdd).not.toHaveBeenCalled()

    screen.getByRole("complementary").parentElement?.setAttribute("hidden", "")
    fireEvent.keyDown(window, { key: "b" })
    expect(onAdd).not.toHaveBeenCalled()
    input.remove()
  })

  it("ignores launcher letters while a menu or dialog is open, but not under composer suggestions", () => {
    const { onAdd } = renderPanel({ surfaces: [], activeId: null })
    const layer = document.createElement("div")
    document.body.append(layer)

    layer.className = "menu-positioner"
    fireEvent.keyDown(window, { key: "t" })
    layer.className = ""
    layer.setAttribute("role", "dialog")
    fireEvent.keyDown(window, { key: "t" })
    expect(onAdd).not.toHaveBeenCalled()

    layer.removeAttribute("role")
    layer.className = "popup menu-popup suggest-panel"
    fireEvent.keyDown(window, { key: "t" })
    expect(onAdd).toHaveBeenCalledWith("terminal")
    layer.remove()
  })

  it("moves the launcher highlight with arrow keys and opens it with Enter", () => {
    const { onAdd } = renderPanel({ surfaces: [], activeId: null })
    const launcher = screen.getByLabelText("打开一个面板")

    fireEvent.keyDown(launcher, { key: "ArrowDown" })
    fireEvent.keyDown(launcher, { key: "ArrowDown" })
    fireEvent.keyDown(launcher, { key: "Enter" })
    expect(onAdd).toHaveBeenCalledWith("terminal")
  })

  it("adds a surface from the + menu with a letter shortcut", async () => {
    const { onAdd } = renderPanel()

    await userEvent.click(screen.getByRole("button", { name: "添加面板" }))
    const menu = await screen.findByRole("menu")
    expect(within(menu).getAllByRole("menuitem")).toHaveLength(6)

    fireEvent.keyDown(menu, { key: "d" })
    expect(onAdd).toHaveBeenCalledWith("diff")
  })

  it("builds the launcher and the + menu from the surfaces in the registry", async () => {
    const registry = workbenchRegistry()
    renderPanel({ surfaces: [], activeId: null }, registry)
    const launcher = screen.getByLabelText("打开一个面板")
    expect(
      within(launcher)
        .getAllByRole("button")
        .map((button) => [button.textContent, button.getAttribute("aria-keyshortcuts")]),
    ).toEqual([
      ["浏览器B", "B"],
      ["终端T", "T"],
      ["文件F", "F"],
      ["DiffD", "D"],
      ["PRP", "P"],
      ["检查点C", "C"],
    ])
    expect(within(launcher).queryByText("插件")).toBeNull()

    // 插件登记的 Surface 出现在「插件」组里；注销后消失。
    let dispose = () => {}
    act(() => {
      dispose = registry.register(
        "surface",
        pluginSurface("debug-inspector", "Debug Inspector", "状态"),
      )
    })
    expect(within(launcher).getByText("插件")).toBeTruthy()
    expect(within(launcher).getByRole("button", { name: "Debug Inspector" }).title).toBe("状态")
    act(() => dispose())
    expect(within(launcher).queryByRole("button", { name: "Debug Inspector" })).toBeNull()

    // 内置 Surface 注销后也不再列出。
    act(() => registry.removeOwner({ kind: "builtin", id: "workbench" }))
    expect(within(launcher).queryAllByRole("button")).toEqual([])
  })

  it("lists plugin surfaces in the launcher and the + menu, with their icon on their tabs", async () => {
    const registry = workbenchRegistry()
    registry.register("surface", pluginSurface("debug-inspector", "Debug Inspector", "状态"))
    const { onAdd } = renderPanel({ surfaces: [], activeId: null }, registry)
    expect(screen.getByText("插件")).toBeTruthy()
    await userEvent.click(screen.getByRole("button", { name: "Debug Inspector" }))
    expect(onAdd).toHaveBeenCalledWith("debug-inspector")
    cleanup()

    const handlers = renderPanel(
      {
        surfaces: [{ id: "p1", kind: "debug-inspector", title: "Debug Inspector" }],
        activeId: "p1",
      },
      registry,
    )
    expect(screen.getByRole("tab", { name: "Debug Inspector" })).toBeTruthy()
    await userEvent.click(screen.getByRole("button", { name: "添加面板" }))
    const menu = await screen.findByRole("menu")
    expect(
      within(menu)
        .getAllByRole("menuitem")
        .map((item) => item.textContent),
    ).toEqual(["浏览器B", "终端T", "文件F", "DiffD", "PRP", "检查点C", "Debug Inspector"])
    await userEvent.click(within(menu).getByRole("menuitem", { name: "Debug Inspector" }))
    expect(handlers.onAdd).toHaveBeenCalledWith("debug-inspector")
  })
})
