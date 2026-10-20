/** 验证插件列表与安装表单。 */
// @vitest-environment jsdom
import { render, screen } from "@testing-library/react"
import { describe, expect, it } from "vitest"
import { LocaleProvider } from "@pigcode/ui-primitives"
import { PluginManagerView } from "./plugin-manager-view"

describe("PluginManagerView", () => {
  it("renders installed plugins", () => {
    render(
      <LocaleProvider locale="zh-CN">
        <PluginManagerView
          plugins={[
            {
              id: "ui.demo",
              name: "demo",
              version: "0.0.0",
              kind: "ui",
              enabled: true,
              error: null,
            },
          ]}
          onInstall={async () => {}}
          onEnable={async () => {}}
          onDisable={async () => {}}
          onRefresh={async () => {}}
        />
      </LocaleProvider>,
    )
    expect(screen.getByText("demo")).toBeTruthy()
  })
})
