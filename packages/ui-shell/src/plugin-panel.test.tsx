// @vitest-environment jsdom
/**
 * 验证插件内容的两种写法（ADR-0002）：`Component` 在宿主树里渲染、出错时只在内容区显示原因；
 * `render` 仍是 DOM 渲染函数，容器清空、清理函数照常调用。
 */
import { render, screen } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"
import { LocaleProvider } from "@pigcode/ui-primitives"
import { PluginContentHost } from "./plugin-panel"

afterEach(() => {
  vi.restoreAllMocks()
})

/** 宿主外壳：插件组件读 useLocale 时依赖它。 */
function host(children: React.ReactNode) {
  return render(<LocaleProvider locale="zh-CN">{children}</LocaleProvider>)
}

describe("PluginContentHost", () => {
  it("renders a plugin Component inside the host tree, inside the host's locale context", () => {
    function Panel() {
      return <p>inside host</p>
    }
    const view = host(<PluginContentHost id="react" Component={Panel} kind="panel" />)

    expect(screen.getByText("inside host")).toBeTruthy()
    const container = view.container.querySelector("[data-plugin-content='react']")
    expect(container?.className).toBe("pg-root pg-panel")
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

  it("keeps the DOM render function path: fills the container and runs its cleanup", () => {
    const cleanup = vi.fn()
    const draw = vi.fn((container: HTMLElement) => {
      const node = document.createElement("span")
      node.textContent = "dom content"
      container.append(node)
      return cleanup
    })
    const view = host(<PluginContentHost id="dom" render={draw} kind="settings" />)

    expect(draw).toHaveBeenCalledTimes(1)
    expect(screen.getByText("dom content")).toBeTruthy()

    view.unmount()
    expect(cleanup).toHaveBeenCalledTimes(1)
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
