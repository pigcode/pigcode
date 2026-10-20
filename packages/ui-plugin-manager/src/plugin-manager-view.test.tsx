/** 验证插件列表、权限/冲突展示与安装表单。 */
// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { afterEach, describe, expect, it, vi } from "vitest"
import { LocaleProvider } from "@pigcode/ui-primitives"
import { PluginManagerView, type PluginManagerViewProps } from "./plugin-manager-view"

// Vitest 未开启 globals，Testing Library 不会自动清理；手动清理避免用例间残留。
afterEach(cleanup)

/** 渲染插件管理视图，默认安装回调为空。 */
function renderView(
  plugins: PluginManagerViewProps["plugins"],
  onInstall: PluginManagerViewProps["onInstall"] = async () => undefined,
): void {
  render(
    <LocaleProvider locale="zh-CN">
      <PluginManagerView
        plugins={plugins}
        onInstall={onInstall}
        onEnable={async () => {}}
        onDisable={async () => {}}
        onRefresh={async () => {}}
      />
    </LocaleProvider>,
  )
}

describe("PluginManagerView", () => {
  it("renders installed plugins", () => {
    renderView([
      {
        id: "ui.demo",
        name: "demo",
        version: "0.0.0",
        kind: "ui",
        enabled: true,
        error: null,
        apiVersion: 1,
        permissions: [],
        provides: [],
        contributes: {},
        conflict: null,
      },
    ])
    expect(screen.getByText("demo")).toBeTruthy()
  })

  it("renders permissions and conflicts", () => {
    renderView([
      {
        id: "provider.demo",
        name: "demo",
        version: "1.0.0",
        kind: "provider",
        enabled: true,
        error: null,
        apiVersion: 1,
        permissions: ["process:spawn"],
        provides: ["provider:demo"],
        contributes: {},
        conflict: "provides conflict: provider:demo",
      },
    ])
    expect(screen.getByText("process:spawn")).toBeTruthy()
    expect(screen.getByText(/conflict/)).toBeTruthy()
  })

  it("installs from a local directory or npm spec", async () => {
    const onInstall = vi.fn(async (): Promise<void> => undefined)
    renderView([], onInstall)
    const user = userEvent.setup()
    const spec = "pigcode-provider-demo@1.0.0"
    await user.type(screen.getByLabelText("插件目录或 npm 包"), spec)
    await user.click(screen.getByRole("button", { name: "安装插件" }))
    expect(onInstall).toHaveBeenCalledWith(spec)
  })
})
