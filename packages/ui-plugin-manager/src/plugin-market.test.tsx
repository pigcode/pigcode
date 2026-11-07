/**
 * 验证插件市场：有市场时默认看市场，卡片上的安装 / 已安装 / 更新，市场插件的详情，「添加」菜单里的创建插件、
 * 添加插件市场（必须勾选风险确认）与安装插件，插件市场来源（刷新、删除先确认），没有市场时的说明，
 * Host 错误换成说明文案，以及版本比较。
 */
// @vitest-environment jsdom
import { cleanup, render, screen, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { afterEach, describe, expect, it, vi } from "vitest"
import { LocaleProvider, translate, type MessageKey } from "@pigcode/ui-primitives"
import { PluginManagerView, type PluginManagerViewProps } from "./plugin-manager-view"
import {
  isNewerVersion,
  pluginErrorText,
  type MarketplaceSummary,
  type PluginSummary,
} from "./plugin-summary"

afterEach(cleanup)

const CLOCK: PluginSummary = {
  id: "capability.pigcode-clock",
  name: "pigcode-clock",
  displayName: "Clock",
  version: "0.1.0",
  kind: "capability",
  enabled: true,
  error: null,
  apiVersion: 1,
  permissions: [],
  provides: [],
  contributes: {},
  conflict: null,
  origin: { kind: "marketplace", marketplace: "dev-tools", plugin: "pigcode-clock" },
  originLabel: "pigcode-clock@dev-tools",
}

const MARKET: MarketplaceSummary = {
  id: "dev-tools",
  displayName: "开发工具",
  description: null,
  owner: "Alice",
  sourceType: "github",
  sourceLabel: "acme/tools",
  addedAt: "2026-11-01T00:00:00.000Z",
  lastUpdated: "2026-11-01T00:00:00.000Z",
  error: null,
  plugins: [
    {
      name: "pigcode-clock",
      displayName: "时钟",
      description: "把当前时间给 agent",
      version: "0.2.0",
      category: "productivity",
      icon: null,
      homepage: "https://example.com/clock",
      author: "Alice",
      sourceLabel: "plugins/clock",
    },
    {
      name: "pigcode-notes",
      displayName: "笔记",
      description: "在侧栏记笔记",
      version: "1.0.0",
      category: null,
      icon: null,
      homepage: null,
      author: null,
      sourceLabel: "plugins/notes",
    },
  ],
}

function renderView(overrides: Partial<PluginManagerViewProps> = {}) {
  const props: PluginManagerViewProps = {
    plugins: [CLOCK],
    marketplaces: [MARKET],
    onInstall: vi.fn(async () => undefined),
    onEnable: vi.fn(async () => {}),
    onDisable: vi.fn(async () => {}),
    onRefresh: vi.fn(async () => {}),
    onInstallFromMarketplace: vi.fn(async () => {}),
    onUpdate: vi.fn(async () => {}),
    onAddMarketplace: vi.fn(async () => {}),
    onRefreshMarketplaces: vi.fn(async () => {}),
    onRemoveMarketplace: vi.fn(async () => {}),
    onCreatePlugin: vi.fn(async () => true),
    onOpenExternal: vi.fn(),
    ...overrides,
  }
  render(
    <LocaleProvider locale="zh-CN">
      <PluginManagerView {...props} />
    </LocaleProvider>,
  )
  return props
}

async function openAddMenu(): Promise<void> {
  await userEvent.click(screen.getByRole("button", { name: /^添加/ }))
}

describe("plugin marketplace", () => {
  it("shows the marketplace first, with install, installed and update states on the cards", async () => {
    const props = renderView()
    expect(screen.getByRole("radio", { name: "插件市场" }).getAttribute("aria-checked")).toBe(
      "true",
    )
    const section = screen.getByRole("region", { name: "开发工具" })
    expect(section.textContent).toContain("GitHub · acme/tools · 2 个插件")
    // 已经装了 0.1.0，市场里是 0.2.0：可以更新。
    const clock = within(section)
      .getByRole("button", { name: "时钟 的详情" })
      .closest(".market-tile")!
    expect(clock.textContent).toContain("可更新")
    await userEvent.click(within(section).getByRole("button", { name: "更新 时钟" }))
    expect(props.onUpdate).toHaveBeenCalledWith("capability.pigcode-clock")
    await userEvent.click(within(section).getByRole("button", { name: "安装 笔记" }))
    expect(props.onInstallFromMarketplace).toHaveBeenCalledWith("dev-tools", "pigcode-notes")
  })

  it("marks plugins that are already up to date as installed and searches across marketplaces", async () => {
    renderView({ plugins: [{ ...CLOCK, version: "0.2.0" }] })
    const clock = screen.getByRole("button", { name: "时钟 的详情" }).closest(".market-tile")!
    expect(clock.textContent).toContain("已安装")
    expect(clock.textContent).not.toContain("可更新")
    await userEvent.type(screen.getByRole("searchbox"), "笔记")
    expect(screen.queryByRole("button", { name: "时钟 的详情" })).toBeNull()
    expect(screen.getByRole("button", { name: "笔记 的详情" })).toBeTruthy()
  })

  it("opens a marketplace plugin's details with its facts and homepage", async () => {
    const props = renderView()
    await userEvent.click(screen.getByRole("button", { name: "时钟 的详情" }))
    const dialog = await screen.findByRole("dialog", { name: "时钟" })
    expect(dialog.textContent).toContain("市场里有新版本 0.2.0")
    expect(dialog.textContent).toContain("pigcode-clock")
    expect(dialog.textContent).toContain("Alice")
    await userEvent.click(within(dialog).getByRole("button", { name: /example\.com\/clock/ }))
    expect(props.onOpenExternal).toHaveBeenCalledWith("https://example.com/clock")
    await userEvent.click(within(dialog).getByRole("button", { name: "更新" }))
    expect(props.onUpdate).toHaveBeenCalledWith("capability.pigcode-clock")
  })

  it("creates a plugin from the Add menu and explains when there's no project yet", async () => {
    const onCreatePlugin = vi.fn(async () => false)
    renderView({ onCreatePlugin })
    await openAddMenu()
    await userEvent.click(await screen.findByRole("menuitem", { name: /创建插件/ }))
    expect(onCreatePlugin).toHaveBeenCalled()
    expect((await screen.findByRole("alert")).textContent).toContain("先添加一个项目")
  })

  it("only adds a marketplace after the risk is acknowledged, and keeps the input on failure", async () => {
    const onAddMarketplace = vi
      .fn<(source: string) => Promise<void>>()
      .mockRejectedValueOnce(new Error("MARKETPLACE_NOT_FOUND: no marketplace.json in this source"))
      .mockResolvedValueOnce(undefined)
    renderView({ onAddMarketplace })
    await openAddMenu()
    await userEvent.click(await screen.findByRole("menuitem", { name: /添加插件市场/ }))
    const dialog = await screen.findByRole("dialog", { name: "添加插件市场" })
    await userEvent.type(within(dialog).getByLabelText("来源"), "acme/tools")
    const submit = within(dialog).getByRole("button", { name: "添加" }) as HTMLButtonElement
    expect(submit.disabled).toBe(true)
    await userEvent.click(within(dialog).getByRole("checkbox", { name: /我已了解风险/ }))
    expect(submit.disabled).toBe(false)
    await userEvent.click(submit)
    expect((await within(dialog).findByRole("alert")).textContent).toContain(
      "这里没有插件市场的目录文件",
    )
    expect((within(dialog).getByLabelText("来源") as HTMLInputElement).value).toBe("acme/tools")
    await userEvent.click(submit)
    expect(onAddMarketplace).toHaveBeenLastCalledWith("acme/tools")
    await vi.waitFor(() =>
      expect(screen.queryByRole("dialog", { name: "添加插件市场" })).toBeNull(),
    )
  })

  it("refreshes and removes marketplaces in the sources dialog", async () => {
    const props = renderView()
    await userEvent.click(screen.getByRole("button", { name: /^市场源/ }))
    const dialog = await screen.findByRole("dialog", { name: "市场源" })
    expect(within(dialog).getByRole("status").textContent).toBe("1 个市场源")
    // 从这个来源装了时钟：一行里写着已安装几个。
    expect(dialog.textContent).toContain("2 个插件 · 已安装 1 个")
    await userEvent.click(within(dialog).getByRole("button", { name: "刷新 开发工具" }))
    expect(props.onRefreshMarketplaces).toHaveBeenCalledWith("dev-tools")
    await userEvent.click(within(dialog).getByRole("button", { name: "全部刷新" }))
    expect(props.onRefreshMarketplaces).toHaveBeenLastCalledWith()
    await userEvent.click(within(dialog).getByRole("button", { name: "开发工具 的更多操作" }))
    await userEvent.click(await screen.findByRole("menuitem", { name: "删除市场源" }))
    expect(props.onRemoveMarketplace).not.toHaveBeenCalled()
    expect(dialog.textContent).toContain("从它安装的插件会保留")
    await userEvent.click(within(dialog).getByRole("button", { name: "删除" }))
    expect(props.onRemoveMarketplace).toHaveBeenCalledWith("dev-tools")
  })

  it("disables a source in the sources dialog and opens or copies where it comes from", async () => {
    const onSetMarketplaceEnabled = vi.fn(async () => {})
    const props = renderView({
      onSetMarketplaceEnabled,
      marketplaces: [{ ...MARKET, sourceUrl: "https://github.com/acme/tools", enabled: true }],
    })
    await userEvent.click(screen.getByRole("button", { name: /^市场源/ }))
    const dialog = await screen.findByRole("dialog", { name: "市场源" })
    await userEvent.click(within(dialog).getByRole("switch", { name: "启用 开发工具" }))
    expect(onSetMarketplaceEnabled).toHaveBeenCalledWith("dev-tools", false)

    await userEvent.click(within(dialog).getByRole("button", { name: "开发工具 的更多操作" }))
    await userEvent.click(await screen.findByRole("menuitem", { name: "在浏览器中打开" }))
    expect(props.onOpenExternal).toHaveBeenCalledWith("https://github.com/acme/tools")
  })

  it("hides disabled sources from the marketplace and their updates from the plugin list", async () => {
    const onSetMarketplaceEnabled = vi.fn(async () => {})
    renderView({ onSetMarketplaceEnabled, marketplaces: [{ ...MARKET, enabled: false }] })
    expect(screen.queryByRole("region", { name: "开发工具" })).toBeNull()
    expect(screen.getByText("市场源都已停用")).toBeTruthy()
    await userEvent.click(screen.getByRole("button", { name: "管理市场源…" }))
    const dialog = await screen.findByRole("dialog", { name: "市场源" })
    expect(within(dialog).getByRole("status").textContent).toBe("1 个市场源，1 个已停用")
    expect(dialog.textContent).toContain("已停用")
    await userEvent.click(within(dialog).getByRole("switch", { name: "启用 开发工具" }))
    expect(onSetMarketplaceEnabled).toHaveBeenCalledWith("dev-tools", true)
    await userEvent.keyboard("{Escape}")

    // 已安装的时钟在停用的市场里有新版本，但不提示更新。
    await userEvent.click(screen.getByRole("radio", { name: "已安装 1" }))
    expect(screen.queryByRole("button", { name: /更新/ })).toBeNull()
  })

  it("acts on a source from the menu next to its marketplace heading", async () => {
    const onSetMarketplaceEnabled = vi.fn(async () => {})
    const props = renderView({ onSetMarketplaceEnabled })
    const menu = () => userEvent.click(screen.getByRole("button", { name: "开发工具 的操作" }))
    await menu()
    await userEvent.click(await screen.findByRole("menuitem", { name: "刷新这个市场源" }))
    expect(props.onRefreshMarketplaces).toHaveBeenCalledWith("dev-tools")
    await menu()
    await userEvent.click(await screen.findByRole("menuitem", { name: "停用这个市场源" }))
    expect(onSetMarketplaceEnabled).toHaveBeenCalledWith("dev-tools", false)
    await menu()
    await userEvent.click(await screen.findByRole("menuitem", { name: "管理市场源…" }))
    expect(await screen.findByRole("dialog", { name: "市场源" })).toBeTruthy()
  })

  it("explains marketplaces when there are none, with ways to get plugins", async () => {
    const props = renderView({ marketplaces: [] })
    // 没有市场时先看已安装的插件；切到插件市场是一段说明。
    expect(screen.getByRole("radio", { name: "已安装 1" }).getAttribute("aria-checked")).toBe(
      "true",
    )
    await userEvent.click(screen.getByRole("radio", { name: "插件市场" }))
    expect(screen.getByRole("heading", { name: "还没有插件市场" })).toBeTruthy()
    await userEvent.click(screen.getByRole("button", { name: "从 GitHub 安装" }))
    expect(await screen.findByRole("dialog", { name: "安装插件" })).toBeTruthy()
    await userEvent.keyboard("{Escape}")
    await userEvent.click(screen.getByRole("button", { name: "创建插件" }))
    expect(props.onCreatePlugin).toHaveBeenCalled()
  })

  it("shows where an installed plugin came from and updates it from its details", async () => {
    const props = renderView({ marketplaces: [] })
    await userEvent.click(screen.getByRole("button", { name: "Clock 的详情" }))
    const dialog = await screen.findByRole("dialog", { name: "Clock" })
    expect(dialog.textContent).toContain("pigcode-clock@dev-tools")
    await userEvent.click(within(dialog).getByRole("button", { name: "更新" }))
    expect(props.onUpdate).toHaveBeenCalledWith("capability.pigcode-clock")
  })

  it("explains a GitHub install failure in plain words", async () => {
    const onInstall = vi.fn(async () => {
      throw new Error("PLUGIN_GITHUB_NOT_FOUND: acme/missing")
    })
    renderView({ onInstall, marketplaces: [] })
    await openAddMenu()
    await userEvent.click(await screen.findByRole("menuitem", { name: /安装插件/ }))
    const dialog = await screen.findByRole("dialog", { name: "安装插件" })
    await userEvent.type(
      within(dialog).getByLabelText("GitHub 仓库、npm 包或插件目录"),
      "acme/missing",
    )
    await userEvent.click(within(dialog).getByRole("button", { name: "安装" }))
    expect((await within(dialog).findByRole("alert")).textContent).toContain(
      "找不到这个 GitHub 仓库或分支：acme/missing",
    )
  })
})

describe("plugin helpers", () => {
  const t = (key: MessageKey) => translate("zh-CN", key)

  it("compares versions numerically, with releases newer than pre-releases", () => {
    expect(isNewerVersion("0.10.0", "0.9.9")).toBe(true)
    expect(isNewerVersion("1.0.0", "1.0.0")).toBe(false)
    expect(isNewerVersion("1.0.0", "1.0.0-beta.2")).toBe(true)
    expect(isNewerVersion("1.0.0-beta.2", "1.0.0")).toBe(false)
    expect(isNewerVersion("v2", "1.9.9")).toBe(true)
  })

  it("turns Host error codes into explanations and leaves other errors alone", () => {
    expect(
      pluginErrorText(
        new Error("MARKETPLACE_CLAUDE_FORMAT: this is a Claude Code plugin marketplace"),
        t,
      ),
    ).toContain("Claude Code 的插件市场")
    expect(
      pluginErrorText("Error invoking remote method: PLUGIN_SOURCE_IS_MARKETPLACE: x", t),
    ).toContain("添加插件市场")
    expect(pluginErrorText(new Error("something else"), t)).toBe("something else")
  })
})
