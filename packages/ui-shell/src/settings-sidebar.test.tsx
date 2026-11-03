/**
 * 验证设置导航与内容区都来自设置页扩展点：内置的页按顺序列在「设置」组，插件的页列在「插件设置」组，
 * 搜索按名称过滤两组；内容区画当前页，当前页被移除时退回通用页。
 */
// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"
import {
  ExtensionRegistryScope,
  createExtensionRegistry,
  type ExtensionRegistry,
  type SettingsPageContribution,
} from "@pigcode/client-runtime"
import { LocaleProvider } from "@pigcode/ui-primitives"
import { SettingsSidebar } from "./settings-sidebar"
import { SettingsView, settingsPageOrFallback } from "./settings-view"

afterEach(() => cleanup())

function Glyph() {
  return <svg data-testid="glyph" />
}

function page(
  id: string,
  order: number,
  title: SettingsPageContribution["title"],
  owner: SettingsPageContribution["owner"] = { kind: "builtin", id: "settings" },
): SettingsPageContribution {
  return { id, owner, order, title, icon: Glyph, render: () => <h1>{`page ${id}`}</h1> }
}

const plugin = { kind: "plugin", id: "ui.debug" } as const

/** 两个内置页（故意倒序登记）和一个 order 更小的插件页。 */
function registryWithPages(): ExtensionRegistry {
  const registry = createExtensionRegistry()
  registry.register("settingsPage", page("appearance", 20, { key: "settings.appearance" }))
  registry.register("settingsPage", page("general", 10, { key: "settings.general" }))
  registry.register("settingsPage", page("debug", 0, { text: "Debug Settings" }, plugin))
  return registry
}

function renderSidebar(registry: ExtensionRegistry, onSelect = vi.fn()) {
  render(
    <LocaleProvider locale="zh-CN">
      <ExtensionRegistryScope registry={registry}>
        <SettingsSidebar activePage="appearance" onSelect={onSelect} onExit={() => {}} />
      </ExtensionRegistryScope>
    </LocaleProvider>,
  )
  return onSelect
}

const navNames = () =>
  screen
    .getAllByRole("button")
    .filter((button) => button.classList.contains("nav-item") && !button.matches(".back"))
    .map((button) => button.textContent)

describe("SettingsSidebar", () => {
  it("lists built-in pages in order under 设置 and plugin pages after them under 插件设置", () => {
    renderSidebar(registryWithPages())
    expect(navNames()).toEqual(["通用", "外观", "Debug Settings"])
    expect([...document.querySelectorAll(".side-group")].map((group) => group.textContent)).toEqual(
      ["设置", "插件设置"],
    )
    expect(screen.getByRole("button", { name: "外观" }).getAttribute("aria-current")).toBe("page")
    expect(screen.getAllByTestId("glyph")).toHaveLength(3)
  })

  it("selects a page by its id", () => {
    const onSelect = renderSidebar(registryWithPages())
    fireEvent.click(screen.getByRole("button", { name: "Debug Settings" }))
    expect(onSelect).toHaveBeenCalledWith("debug")
  })

  it("searches the names of built-in and plugin pages, and Enter opens the first match", () => {
    const onSelect = renderSidebar(registryWithPages())
    const search = screen.getByPlaceholderText("搜索设置")
    fireEvent.change(search, { target: { value: "debug" } })
    expect(navNames()).toEqual(["Debug Settings"])
    // 没有匹配的内置页时不留空的「设置」组标题。
    expect([...document.querySelectorAll(".side-group")].map((group) => group.textContent)).toEqual(
      ["插件设置"],
    )
    fireEvent.keyDown(search, { key: "Enter" })
    expect(onSelect).toHaveBeenCalledWith("debug")

    fireEvent.change(search, { target: { value: "外" } })
    expect(navNames()).toEqual(["外观"])
    expect(screen.queryByText("插件设置")).toBeNull()

    fireEvent.change(search, { target: { value: "nothing" } })
    expect(navNames()).toEqual([])
    expect(screen.getByText("没有匹配的设置")).toBeTruthy()
    expect(document.querySelectorAll(".side-group")).toHaveLength(0)
  })

  it("follows pages added and removed later", () => {
    const registry = registryWithPages()
    renderSidebar(registry)
    let dispose = () => {}
    act(() => {
      dispose = registry.register(
        "settingsPage",
        page("extra", 5, { text: "Extra" }, { kind: "plugin", id: "ui.extra" }),
      )
    })
    expect(navNames()).toEqual(["通用", "外观", "Debug Settings", "Extra"])
    act(() => {
      dispose()
      registry.removeOwner(plugin)
    })
    expect(navNames()).toEqual(["通用", "外观"])
    expect(screen.queryByText("插件设置")).toBeNull()
  })
})

describe("SettingsView", () => {
  it("renders the current page inside the settings region", () => {
    render(
      <LocaleProvider locale="zh-CN">
        <ExtensionRegistryScope registry={registryWithPages()}>
          <SettingsView page="debug" />
        </ExtensionRegistryScope>
      </LocaleProvider>,
    )
    const region = screen.getByRole("region", { name: "设置" })
    expect(region.querySelector(".panel-scroll")?.textContent).toBe("page debug")
  })

  it("shows a page that throws as an error in the content area only, and recovers on another page", () => {
    vi.spyOn(console, "error").mockImplementation(() => {})
    const registry = registryWithPages()
    registry.register("settingsPage", {
      ...page("broken", 30, { text: "Broken" }),
      render: () => {
        function Broken(): never {
          throw new Error("chunk failed")
        }
        return <Broken />
      },
    })
    const view = (id: string) => (
      <LocaleProvider locale="zh-CN">
        <ExtensionRegistryScope registry={registry}>
          <SettingsView page={id} />
        </ExtensionRegistryScope>
      </LocaleProvider>
    )
    const { rerender } = render(view("broken"))
    expect(screen.getByText("这个设置页没有显示出来")).toBeTruthy()
    expect(screen.getByText("chunk failed")).toBeTruthy()
    rerender(view("general"))
    expect(screen.getByRole("heading", { name: "page general" })).toBeTruthy()
    vi.restoreAllMocks()
  })

  it("falls back to the general page, then the first page, when the current one is gone", () => {
    const registry = registryWithPages()
    const pages = () => registry.get("settingsPage")
    expect(settingsPageOrFallback(pages(), "debug")).toBe("debug")
    registry.removeOwner(plugin)
    expect(settingsPageOrFallback(pages(), "debug")).toBe("general")

    const withoutGeneral = createExtensionRegistry()
    withoutGeneral.register("settingsPage", page("appearance", 20, { key: "settings.appearance" }))
    expect(settingsPageOrFallback(withoutGeneral.get("settingsPage"), "debug")).toBe("appearance")
    expect(settingsPageOrFallback([], "debug")).toBe("debug")
  })
})
