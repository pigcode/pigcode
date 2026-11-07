/** 验证插件页：按类型分组的卡片、详情里的权限与冲突、启用开关、更多菜单、搜索、收起与安装对话框。 */
// @vitest-environment jsdom
import { cleanup, render, screen, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { afterEach, describe, expect, it, vi } from "vitest"
import { LocaleProvider } from "@pigcode/ui-primitives"
import { PluginManagerView, type PluginManagerViewProps } from "./plugin-manager-view"
import type { PluginSummary } from "./plugin-summary"

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

/** 某个插件卡片上的主按钮（点开详情）。 */
const tile = (name: string) => screen.getByRole("button", { name: `${name} 的详情` })

/** 打开某个插件的详情，返回对话框。 */
async function openDetails(name: string): Promise<HTMLElement> {
  await userEvent.click(tile(name))
  return screen.findByRole("dialog", { name })
}

describe("PluginManagerView", () => {
  it("groups plugins by kind into sections of cards with a description and a switch", () => {
    renderView([
      { ...DEMO, description: "A demo panel" },
      { ...DEMO, id: "agent.echo", name: "pigcode-agent-echo", displayName: "Echo", kind: "agent" },
    ])
    const headings = screen.getAllByRole("heading", { level: 2 }).map((item) => item.textContent)
    expect(headings).toEqual(["Agent", "界面"])
    const ui = screen.getByRole("region", { name: "界面" })
    expect(within(ui).getByRole("button", { name: "Demo 的详情" }).textContent).toContain(
      "A demo panel",
    )
    // 没有说明时用包名代替。
    expect(tile("Echo").textContent).toContain("pigcode-agent-echo")
    expect(screen.getByRole("switch", { name: "启用 Demo" }).getAttribute("aria-checked")).toBe(
      "true",
    )
  })

  it("uses the agent description written for the current language", () => {
    renderView([
      {
        ...DEMO,
        kind: "agent",
        description: "Example agent",
        contributes: { agent: { id: "demo", description: { "zh-CN": "示例 agent" } } },
      },
    ])
    expect(tile("Demo").textContent).toContain("示例 agent")
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
    expect(tile("Demo").textContent).toContain("有冲突")
    const dialog = await openDetails("Demo")
    expect(within(dialog).getByText("process:spawn")).toBeTruthy()
    expect(within(dialog).getByText("agent:demo")).toBeTruthy()
    expect(within(dialog).getByText(/冲突: provides conflict/)).toBeTruthy()
    expect(within(dialog).getByText("pigcode-ui-demo")).toBeTruthy()
    expect(within(dialog).getByText("0.1.0")).toBeTruthy()
  })

  it("shows why the Host can't support a plugin's apiVersion", async () => {
    const error = "unsupported plugin apiVersion: 2; this Host supports 1"
    renderView([{ ...DEMO, error }])
    expect(tile("Demo").textContent).toContain("加载失败")
    const dialog = await openDetails("Demo")
    expect(within(dialog).getByText(error)).toBeTruthy()
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
    expect(tile("Demo").textContent).toContain("有冲突")
    expect(tile("Other").textContent).not.toContain("有冲突")
    const dialog = await openDetails("Demo")
    expect(
      within(dialog).getByText(
        "右侧面板的 Surface「terminal」已经属于工作台，这个插件的同名登记没有生效。",
      ),
    ).toBeTruthy()
    expect(
      within(dialog).getByText(
        "侧栏 Panel「status」已经属于插件 Other，这个插件的同名登记没有生效。",
      ),
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
    const dialog = await openDetails("Demo")
    expect(
      within(dialog).getByText(
        "Command「$&-{owner}-$'」已经属于内置功能 chat，这个插件的同名登记没有生效。",
      ),
    ).toBeTruthy()
  })

  it("shows UI code that failed to load or run as a failure on the card and in the details", async () => {
    renderView([
      {
        ...DEMO,
        clientErrors: [
          { kind: "import", detail: "Failed to fetch $1" },
          { kind: "apply", detail: "boom" },
        ],
      },
    ])
    expect(tile("Demo").textContent).toContain("加载失败")
    const dialog = await openDetails("Demo")
    expect(within(dialog).getByText("界面代码没有加载成功：Failed to fetch $1")).toBeTruthy()
    expect(within(dialog).getByText("界面代码运行出错：boom")).toBeTruthy()
  })

  it("lists a command that threw without marking the plugin as failed", async () => {
    renderView([{ ...DEMO, clientErrors: [{ kind: "command", detail: "debug-run: boom" }] }])
    expect(tile("Demo").textContent).not.toContain("加载失败")
    const dialog = await openDetails("Demo")
    expect(within(dialog).getByText("命令执行出错：debug-run: boom")).toBeTruthy()
  })

  it("toggles a plugin and uninstalls from the details after confirming", async () => {
    const onDisable = vi.fn(async () => {})
    const onUninstall = vi.fn(async () => {})
    renderView([DEMO], { onDisable, onUninstall })
    await userEvent.click(screen.getByRole("switch", { name: "启用 Demo" }))
    expect(onDisable).toHaveBeenCalledWith("ui.demo")
    const dialog = await openDetails("Demo")
    await userEvent.click(within(dialog).getByRole("button", { name: "卸载" }))
    expect(onUninstall).not.toHaveBeenCalled()
    await userEvent.click(within(dialog).getByRole("button", { name: "确认卸载" }))
    expect(onUninstall).toHaveBeenCalledWith("ui.demo")
  })

  it("starts uninstalling from the card's menu, and built-in plugins have no uninstall", async () => {
    const onUninstall = vi.fn(async () => {})
    renderView([DEMO, { ...DEMO, id: "agent.claude", displayName: "Claude Code", builtin: true }], {
      onUninstall,
    })
    const user = userEvent.setup()
    await user.click(screen.getByRole("button", { name: "Claude Code 的更多操作" }))
    expect(await screen.findByRole("menuitem", { name: "详情" })).toBeTruthy()
    expect(screen.queryByRole("menuitem", { name: "卸载" })).toBeNull()
    await user.keyboard("{Escape}")

    await user.click(screen.getByRole("button", { name: "Demo 的更多操作" }))
    await user.click(await screen.findByRole("menuitem", { name: "卸载" }))
    const dialog = await screen.findByRole("dialog", { name: "Demo" })
    await user.click(within(dialog).getByRole("button", { name: "确认卸载" }))
    expect(onUninstall).toHaveBeenCalledWith("ui.demo")
  })

  it("opens a plugin's settings page from the card", async () => {
    const onOpenSettings = vi.fn()
    renderView(
      [
        { ...DEMO, settingsPage: "debug-settings" },
        { ...DEMO, id: "ui.plain" },
      ],
      {
        onOpenSettings,
      },
    )
    const open = screen.getAllByRole("button", { name: "打开 Demo 的设置" })
    expect(open).toHaveLength(1)
    await userEvent.click(open[0] as HTMLElement)
    expect(onOpenSettings).toHaveBeenCalledWith("debug-settings")
  })

  it("filters by name, description or package, and says so when nothing matches", async () => {
    renderView([
      { ...DEMO, description: "Shows host info" },
      { ...DEMO, id: "agent.echo", name: "pigcode-agent-echo", displayName: "Echo", kind: "agent" },
    ])
    const user = userEvent.setup()
    const search = screen.getByRole("searchbox", { name: "搜索插件" })
    await user.type(search, "host")
    expect(screen.queryByRole("button", { name: "Echo 的详情" })).toBeNull()
    expect(tile("Demo")).toBeTruthy()
    await user.clear(search)
    await user.type(search, "AGENT-ECHO")
    expect(tile("Echo")).toBeTruthy()
    expect(screen.queryByRole("button", { name: "Demo 的详情" })).toBeNull()
    await user.type(search, "zzz")
    expect(screen.getByText("没有匹配的插件")).toBeTruthy()
    await user.keyboard("{Escape}")
    expect(tile("Demo")).toBeTruthy()
  })

  it("collapses a section past three rows and expands it on demand", async () => {
    const many = Array.from({ length: 8 }, (_, index) => ({
      ...DEMO,
      id: `cap.${index}`,
      name: `pigcode-cap-${index}`,
      displayName: `Cap ${index}`,
      kind: "capability" as const,
    }))
    renderView(many)
    const section = screen.getByRole("region", { name: "能力" })
    expect(within(section).getAllByRole("switch")).toHaveLength(6)
    await userEvent.click(within(section).getByRole("button", { name: "显示全部 8 个" }))
    expect(within(section).getAllByRole("switch")).toHaveLength(8)
    await userEvent.click(within(section).getByRole("button", { name: "收起" }))
    expect(within(section).getAllByRole("switch")).toHaveLength(6)
  })

  it("installs from a local directory or npm spec in a dialog", async () => {
    const onInstall = vi.fn(async (): Promise<void> => undefined)
    renderView([], { onInstall })
    const user = userEvent.setup()
    // 没有插件时，标题栏和空状态里各有一个「安装插件」；空状态里的那个同样打开对话框。
    const installs = screen.getAllByRole("button", { name: "安装插件" })
    expect(installs).toHaveLength(2)
    expect(screen.queryByRole("searchbox")).toBeNull()
    await user.click(installs[1] as HTMLElement)
    const spec = "pigcode-agent-demo@1.0.0"
    await user.type(screen.getByLabelText("GitHub 仓库、npm 包或插件目录"), spec)
    await user.click(screen.getByRole("button", { name: "安装" }))
    expect(onInstall).toHaveBeenCalledWith(spec)
  })
})
