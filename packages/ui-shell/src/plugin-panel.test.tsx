// @vitest-environment jsdom
/**
 * 验证插件内容的写法只有一种（ADR-0002）：`Component` 在宿主树里渲染、出错时只在内容区显示原因、
 * 插件换版本后错误不再挡住新组件。
 */
import { render, screen } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"
import { LocaleProvider } from "@pigcode/ui-primitives"
import { PluginContentHost } from "./plugin-panel"

afterEach(() => {
  vi.restoreAllMocks()
})

describe("PluginContentHost", () => {
  it("renders a plugin Component inside the host tree, inside the host's locale context", () => {
    function Panel() {
      return <p>inside host</p>
    }
    const view = render(
      <LocaleProvider locale="zh-CN">
        <PluginContentHost id="react" Component={Panel} kind="panel" />
      </LocaleProvider>,
    )

    expect(screen.getByText("inside host")).toBeTruthy()
    const container = view.container.querySelector("[data-plugin-content='react']")
    expect(container?.className).toBe("plugin-content plugin-content-panel")
  })

  it("shows a component's error in the content area without unmounting the host around it", () => {
    // React 会把错误同时打印到控制台；这里只关心内容区的显示。
    vi.spyOn(console, "error").mockImplementation(() => {})
    function Broken(): React.ReactNode {
      throw new Error("plugin crashed")
    }
    const view = render(
      <LocaleProvider locale="zh-CN">
        <p>host stays</p>
        <PluginContentHost id="broken" Component={Broken} kind="surface" />
      </LocaleProvider>,
    )

    expect(screen.getByText("host stays")).toBeTruthy()
    expect(view.container.querySelector("[data-plugin-content='broken']")?.textContent).toContain(
      "plugin crashed",
    )
  })
})

describe("PluginErrorBoundary through the host", () => {
  it("recovers when the plugin updates to a new component", () => {
    vi.spyOn(console, "error").mockImplementation(() => {})
    function Broken(): React.ReactNode {
      throw new Error("first version crashed")
    }
    function Fixed() {
      return <p>fixed version</p>
    }
    const view = render(
      <LocaleProvider locale="zh-CN">
        <PluginContentHost id="swap" Component={Broken} kind="panel" />
      </LocaleProvider>,
    )
    expect(view.container.textContent).toContain("first version crashed")

    // 插件换版本：同一个 id，组件换成新的，上一版的错误不再挡住它。
    view.rerender(
      <LocaleProvider locale="zh-CN">
        <PluginContentHost id="swap" Component={Fixed} kind="panel" />
      </LocaleProvider>,
    )
    expect(screen.getByText("fixed version")).toBeTruthy()
  })
})
