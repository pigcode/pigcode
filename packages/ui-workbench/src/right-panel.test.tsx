/** 验证右侧面板：surface 状态计算、标签切换与关闭、启动器与添加菜单的快捷键。 */
// @vitest-environment jsdom
import { cleanup, fireEvent, render as renderUi, screen, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import type { ComponentProps, ReactElement } from "react"
import { afterEach, describe, expect, it, vi } from "vitest"
import { LocaleProvider } from "@pigcode/ui-primitives"
import {
  EMPTY_SURFACE_STATE,
  RightPanel,
  addPluginSurface,
  addSurface,
  closeSurface,
  updateSurface,
  type PanelSurface,
} from "./right-panel"

/** 组件文案来自 locale；测试按中文界面渲染。 */
function render(ui: ReactElement) {
  return renderUi(ui, {
    wrapper: ({ children }) => <LocaleProvider locale="zh-CN">{children}</LocaleProvider>,
  })
}

afterEach(() => cleanup())

const terminalTitle = (index: number): string => `终端 ${index}`

describe("surface state", () => {
  it("numbers multi-instance surfaces with the lowest free index", () => {
    let state = addSurface(EMPTY_SURFACE_STATE, "terminal", "a", terminalTitle)
    state = addSurface(state, "terminal", "b", terminalTitle)
    state = closeSurface(state, "a")
    state = addSurface(state, "terminal", "c", terminalTitle)

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
    let state = addSurface(EMPTY_SURFACE_STATE, "terminal", "a", terminalTitle)
    state = addSurface(state, "terminal", "b", terminalTitle)
    state = addSurface(state, "terminal", "c", terminalTitle)
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
    const inspector = { id: "debug-inspector", title: "Debug Inspector" }
    let state = addPluginSurface(EMPTY_SURFACE_STATE, inspector, "p1")
    state = addSurface(state, "terminal", "t1", terminalTitle)
    state = addPluginSurface(state, inspector, "p2")
    expect(state.surfaces).toEqual([
      { id: "p1", kind: "plugin", title: "Debug Inspector", plugin: "debug-inspector" },
      { id: "t1", kind: "terminal", title: "终端 1" },
    ])
    expect(state.activeId).toBe("p1")
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

function renderPanel(props: Partial<ComponentProps<typeof RightPanel>> = {}) {
  const handlers = { onActivate: vi.fn(), onClose: vi.fn(), onAdd: vi.fn() }
  render(
    <RightPanel threadId="t1" surfaces={SURFACES} activeId="s2" {...handlers} {...props}>
      <div>surface body</div>
    </RightPanel>,
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
    const { onAdd } = renderPanel({ surfaces: [], activeId: null, unavailable: { pr: "需要 gh" } })

    const launcher = screen.getByLabelText("打开一个面板")
    const pr = within(launcher).getByRole("button", { name: /PR/ }) as HTMLButtonElement
    expect(pr.disabled).toBe(true)

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

  it("lists plugin surfaces in the launcher and the + menu, with a puzzle icon on their tabs", async () => {
    const onAddPlugin = vi.fn()
    const plugins = [{ id: "debug-inspector", title: "Debug Inspector", description: "状态" }]
    renderPanel({ surfaces: [], activeId: null, plugins, onAddPlugin })
    expect(screen.getByText("插件")).toBeTruthy()
    await userEvent.click(screen.getByRole("button", { name: "Debug Inspector" }))
    expect(onAddPlugin).toHaveBeenCalledWith("debug-inspector")
    cleanup()

    renderPanel({
      surfaces: [{ id: "p1", kind: "plugin", title: "Debug Inspector", plugin: "debug-inspector" }],
      activeId: "p1",
      plugins,
      onAddPlugin,
    })
    expect(screen.getByRole("tab", { name: "Debug Inspector" })).toBeTruthy()
    await userEvent.click(screen.getByRole("button", { name: "添加面板" }))
    const menu = await screen.findByRole("menu")
    await userEvent.click(within(menu).getByRole("menuitem", { name: "Debug Inspector" }))
    expect(onAddPlugin).toHaveBeenCalledTimes(2)
  })
})
