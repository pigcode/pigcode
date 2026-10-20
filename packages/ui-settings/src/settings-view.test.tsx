/** 验证设置页切换与插件列表渲染。 */
// @vitest-environment jsdom
import { render, screen } from "@testing-library/react"
import { describe, expect, it } from "vitest"
import { LocaleProvider } from "@pigcode/ui-primitives"
import { SettingsView } from "./settings-view"

describe("SettingsView", () => {
  it("renders the settings navigation", () => {
    render(
      <LocaleProvider locale="zh-CN">
        <SettingsView section="general" onSection={() => {}} onClose={() => {}} />
      </LocaleProvider>,
    )
    expect(screen.getByText("通用")).toBeTruthy()
    expect(screen.getByText("外观")).toBeTruthy()
  })
})
