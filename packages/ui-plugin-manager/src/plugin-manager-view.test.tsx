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
        id: "agent.demo",
        kind: "agent",
        permissions: ["process:spawn"],
        provides: ["agent:demo"],
        conflict: "provides conflict: agent:demo",
      },
    ])
    expect(screen.getByRole("button", { name: "Demo 的详情" }).textContent).toContain("有冲突")
    await userEvent.click(screen.getByRole("button", { name: "Demo 的详情" }))
    expect(screen.getByText("process:spawn")).toBeTruthy()
    expect(screen.getByText("agent:demo")).toBeTruthy()
    expect(screen.getByText(/冲突: provides conflict/)).toBeTruthy()
  })

  it("shows why the Host can't support a plugin's apiVersion", async () => {
    const error = "unsupported plugin apiVersion: 2; this Host supports 1"
    renderView([{ ...DEMO, error }])
    const row = screen.getByRole("button", { name: "Demo 的详情" })
    expect(row.textContent).toContain("加载失败")
    await userEvent.click(row)
    expect(screen.getByText(error)).toBeTruthy()
  })

  it("shows extension point conflicts with the point, the id and the owner that kept it", async () => {
    const other: PluginSummary = {
      ...DEMO,
      id: "ui.other",
      name: "pigcode-ui-other",
      displayName: "Other",
    }
    renderView([
      {
        ...DEMO,
        contributionConflicts: [
          { point: "surface", id: "terminal", owner: { kind: "builtin", id: "workbench" } },
          { point: "panel", id: "status", owner: { kind: "plugin", id: "ui.other" } },
        ],
      },
      other,
    ])
    expect(screen.getByRole("button", { name: "Demo 的详情" }).textContent).toContain("有冲突")
    expect(screen.getByRole("button", { name: "Other 的详情" }).textContent).toContain("已启用")
    await userEvent.click(screen.getByRole("button", { name: "Demo 的详情" }))
    expect(
      screen.getByText(
        "右侧面板的 Surface「terminal」已经属于工作台，这个插件的同名登记没有生效。",
      ),
    ).toBeTruthy()
    expect(
      screen.getByText("侧栏 Panel「status」已经属于插件 Other，这个插件的同名登记没有生效。"),
    ).toBeTruthy()
  })

  it("fills conflict text in one pass, so ids with $ patterns or placeholders stay literal", async () => {
    renderView([
      {
        ...DEMO,
        contributionConflicts: [
          { point: "command", id: "$&-{owner}-$'", owner: { kind: "builtin", id: "chat" } },
        ],
      },
    ])
    await userEvent.click(screen.getByRole("button", { name: "Demo 的详情" }))
    expect(
      screen.getByText(
        "Command「$&-{owner}-$'」已经属于内置功能 chat，这个插件的同名登记没有生效。",
      ),
    ).toBeTruthy()
  })

  it("shows UI code that failed to load or run as a failure in the row and the details", async () => {
    renderView([
      {
        ...DEMO,
        clientErrors: [
          { kind: "import", detail: "Failed to fetch $1" },
          { kind: "apply", detail: "boom" },
        ],
      },
    ])
    expect(screen.getByRole("button", { name: "Demo 的详情" }).textContent).toContain("加载失败")
    await userEvent.click(screen.getByRole("button", { name: "Demo 的详情" }))
    expect(screen.getByText("界面代码没有加载成功：Failed to fetch $1")).toBeTruthy()
    expect(screen.getByText("界面代码运行出错：boom")).toBeTruthy()
  })

  it("lists a command that threw without marking the plugin as failed", async () => {
    renderView([{ ...DEMO, clientErrors: [{ kind: "command", detail: "debug-run: boom" }] }])
    expect(screen.getByRole("button", { name: "Demo 的详情" }).textContent).not.toContain(
      "加载失败",
    )
    await userEvent.click(screen.getByRole("button", { name: "Demo 的详情" }))
    expect(screen.getByText("命令执行出错：debug-run: boom")).toBeTruthy()
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
    // 没有插件时，标题栏和空状态里各有一个「安装插件」；空状态里的那个同样打开对话框。
    const installs = screen.getAllByRole("button", { name: "安装插件" })
    expect(installs).toHaveLength(2)
    await user.click(installs[1] as HTMLElement)
    const spec = "pigcode-agent-demo@1.0.0"
    await user.type(screen.getByLabelText("插件目录或 npm 包"), spec)
    await user.click(screen.getByRole("button", { name: "安装" }))
    expect(onInstall).toHaveBeenCalledWith(spec)
  })
})
