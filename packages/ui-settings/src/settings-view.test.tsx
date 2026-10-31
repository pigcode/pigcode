/** 验证设置视图按分区渲染页面，且自己不画分区导航（导航在外壳侧栏里）。 */
// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react"
import { afterEach, describe, expect, it } from "vitest"
import { LocaleProvider } from "@pigcode/ui-primitives"
import { SettingsView, type SettingsSection } from "./settings-view"

afterEach(() => cleanup())

function renderView(section: SettingsSection) {
  render(
    <LocaleProvider locale="zh-CN">
      <SettingsView section={section} />
    </LocaleProvider>,
  )
}

describe("SettingsView", () => {
  it("renders the page for the current section", () => {
    renderView("general")
    expect(screen.getByRole("heading", { name: "通用设置" })).toBeTruthy()
  })

  it("has no section navigation of its own", () => {
    renderView("general")
    expect(screen.queryByRole("navigation")).toBeNull()
  })

  it("shows injected pages only in their section", () => {
    render(
      <LocaleProvider locale="zh-CN">
        <SettingsView
          section="plugins"
          pluginManager={<p>插件页</p>}
          agentsPage={<p>Agent 页</p>}
        />
      </LocaleProvider>,
    )
    expect(screen.getByText("插件页")).toBeTruthy()
    expect(screen.queryByText("Agent 页")).toBeNull()
  })
})
