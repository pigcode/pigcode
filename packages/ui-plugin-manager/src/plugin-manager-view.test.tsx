/** 验证插件管理页：和 Agent 页同样的列表行、详情里的权限与冲突、启用开关与安装对话框。 */
// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { afterEach, describe, expect, it, vi } from "vitest"
import { LocaleProvider } from "@pigcode/ui-primitives"
import type { PluginSummary } from "./plugin-list"
import { PluginManagerView, type PluginManagerViewProps } from "./plugin-manager-view"

// Vitest 未开启 globals，Testing Library 不会自动清理；手动清理避免用例间残留。
afterEach(cleanup)

const DEMO: PluginSummary = {
  id: "ui.demo",
  name: "pigcode-ui-demo",
  displayName: "Demo",
  version: "0.1.0",
  kind: "ui",
  enabled: true,
  error: null,
  apiVersion: 1,
  permissions: [],
  provides: [],
  contributes: {},
  conflict: null,
}

function renderView(
  plugins: PluginSummary[],
  overrides: Partial<PluginManagerViewProps> = {},
): void {
  render(
    <LocaleProvider locale="zh-CN">
      <PluginManagerView
        plugins={plugins}
        onInstall={async () => undefined}
        onEnable={async () => {}}
        onDisable={async () => {}}
        onRefresh={async () => {}}
        {...overrides}
      />
    </LocaleProvider>,
  )
}

describe("PluginManagerView", () => {
  it("lists plugins like the agents page with status, kind and package", () => {
    renderView([DEMO])
    const row = screen.getByRole("button", { name: "Demo 的详情" })
    expect(row.textContent).toContain("Demo")
    expect(row.textContent).toContain("0.1.0")
    expect(row.textContent).toContain("已启用")
    expect(row.textContent).toContain("界面 · pigcode-ui-demo")
    expect(screen.getByRole("switch", { name: "启用 Demo" }).getAttribute("aria-checked")).toBe(
      "true",
    )
  })

  it("shows permissions, provides and conflicts in the details", async () => {
    renderView([
      {
        ...DEMO,
        id: "provider.demo",
        kind: "provider",
        permissions: ["process:spawn"],
        provides: ["provider:demo"],
        conflict: "provides conflict: provider:demo",
      },
    ])
    expect(screen.getByRole("button", { name: "Demo 的详情" }).textContent).toContain("有冲突")
    await userEvent.click(screen.getByRole("button", { name: "Demo 的详情" }))
    expect(screen.getByText("process:spawn")).toBeTruthy()
    expect(screen.getByText("provider:demo")).toBeTruthy()
    expect(screen.getByText(/冲突: provides conflict/)).toBeTruthy()
  })

  it("toggles a plugin and uninstalls after confirming", async () => {
    const onDisable = vi.fn(async () => {})
    const onUninstall = vi.fn(async () => {})
    renderView([DEMO], { onDisable, onUninstall })
    await userEvent.click(screen.getByRole("switch", { name: "启用 Demo" }))
    expect(onDisable).toHaveBeenCalledWith("ui.demo")
    await userEvent.click(screen.getByRole("button", { name: "Demo 的详情" }))
    await userEvent.click(screen.getByRole("button", { name: "卸载" }))
    await userEvent.click(screen.getByRole("button", { name: "确认卸载" }))
    expect(onUninstall).toHaveBeenCalledWith("ui.demo")
  })

  it("installs from a local directory or npm spec in a dialog", async () => {
    const onInstall = vi.fn(async (): Promise<void> => undefined)
    renderView([], { onInstall })
    const user = userEvent.setup()
    await user.click(screen.getByRole("button", { name: "安装插件" }))
    const spec = "pigcode-provider-demo@1.0.0"
    await user.type(screen.getByLabelText("插件目录或 npm 包"), spec)
    await user.click(screen.getByRole("button", { name: "安装" }))
    expect(onInstall).toHaveBeenCalledWith(spec)
  })
})
