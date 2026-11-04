// @vitest-environment jsdom
/**
 * 验证插件的设置页：登记到设置页扩展点并归属到插件、和内置页重名时记成冲突、插件更新时不中断；
 * 以及缺了标题或组件的 Panel、Surface、设置页登记被拒绝并记成插件的界面代码错误。
 */
import { render, screen } from "@testing-library/react"
import { useState } from "react"
import { Switch } from "@pigcode/ui-primitives"
import { afterEach, describe, expect, it, vi } from "vitest"
import type { ClientModule } from "@pigcode/client-runtime"
import type { ClientPluginContext } from "@pigcode/plugin-sdk"
import { registerBuiltinSettingsPages } from "./builtin-settings-pages"
import type { CoreDeps } from "./chat-container"
import { deferred, entry, serve, setup } from "./client-plugins.fixtures"

// 宿主界面包里的工作台部分会加载 xterm，jsdom 里没有 canvas；这里用不到它。
vi.mock("@pigcode/ui-workbench", () => ({ FILE_SURFACE_KIND: "file" }))

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe("client plugin settings pages", () => {
  it("registers a settings page owned by the plugin under the host's page title", async () => {
    // 设置页内容是一个 React 组件，用宿主 ui-primitives 的 Switch；组件在宿主的页面外框里渲染。
    const module = {
      apply(ctx: ClientPluginContext) {
        const Verbose = () => {
          const [checked, setChecked] = useState(false)
          return <Switch checked={checked} onCheckedChange={setChecked} aria-label="Verbose" />
        }
        const page = (id: string, title: string) =>
          ctx.settingsPages.register({ id, title, order: 3, Component: Verbose })
        page("debug-settings", "Debug Settings")
        // 和内置页重名：这次登记不生效，先登记的保持。
        page("general", "Mine")
      },
    } as unknown as ClientModule
    const { extensions, controller } = setup(async () => module)
    // 内置设置页只登记，内容不渲染，用不到这些依赖。
    registerBuiltinSettingsPages(extensions, {} as CoreDeps)
    vi.spyOn(console, "error").mockImplementation(() => {})
    serve([entry("ui.debug", "")])

    await controller.reload()

    const pages = extensions.get("settingsPage")
    expect(pages.map((item) => item.id)).toEqual([
      "debug-settings",
      "general",
      "appearance",
      "agents",
      "schedules",
      "plugins",
    ])
    const page = pages[0]
    expect(page).toMatchObject({
      owner: { kind: "plugin", id: "ui.debug" },
      order: 3,
      title: { text: "Debug Settings" },
    })
    expect(pages.find((item) => item.id === "general")?.owner).toEqual({
      kind: "builtin",
      id: "settings",
    })
    expect(extensions.conflicts()).toEqual([
      {
        point: "settingsPage",
        id: "general",
        existing: { kind: "builtin", id: "settings" },
        rejected: { kind: "plugin", id: "ui.debug" },
      },
    ])

    const view = render(<>{page?.render()}</>)
    expect(screen.getByRole("heading", { level: 1, name: "Debug Settings" })).toBeTruthy()
    const content = view.container.querySelector("[data-plugin-content='debug-settings']")
    expect(content?.className).toBe("plugin-content plugin-content-settings")
    expect(screen.getByRole("switch", { name: "Verbose" })).toBeTruthy()
    view.unmount()

    controller.dispose()
    expect(extensions.get("settingsPage").map((item) => item.owner.kind)).toEqual(
      Array(5).fill("builtin"),
    )
  })

  it("keeps a plugin's settings page registered while its new revision loads", async () => {
    const gate = deferred<void>()
    const { extensions, controller } = setup(async (url) => {
      if (url.includes("v2")) await gate.promise
      return (await import(/* @vite-ignore */ url)) as ClientModule
    })
    const pageCall = (title: string) =>
      `ctx.settingsPages.register({ id: "p", title: ${JSON.stringify(title)}, Component() { return null } })`
    serve([entry("ui.a", pageCall("v1"), "1")])
    await controller.reload()

    // 选中的设置页在更新途中哪怕消失一次，界面就会退回通用页：每次变化之后都还得看得到它。
    const seen: string[][] = []
    extensions.subscribe("settingsPage", () =>
      queueMicrotask(() => seen.push(extensions.get("settingsPage").map((item) => item.id))),
    )
    serve([entry("ui.a", pageCall("v2"), "2")])
    const updating = controller.reload()
    await new Promise((done) => setTimeout(done, 10))
    expect(extensions.get("settingsPage")).toMatchObject([{ id: "p", title: { text: "v1" } }])
    gate.resolve()
    await updating

    expect(extensions.get("settingsPage")).toMatchObject([{ id: "p", title: { text: "v2" } }])
    expect(seen.length).toBeGreaterThan(0)
    expect(seen.every((ids) => ids.includes("p"))).toBe(true)
    controller.dispose()
  })

  it("reports a Panel, Surface or settings page with a missing title or component instead of registering it", async () => {
    const { extensions, controller } = setup()
    vi.spyOn(console, "error").mockImplementation(() => {})
    serve([
      entry("ui.panel", `ctx.panels.register({ id: "p", title: "P" })`),
      entry("ui.surface", `ctx.surfaces.register({ id: "s", title: "S" })`),
      entry(
        "ui.page",
        `ctx.settingsPages.register({ id: "g", title: 3, Component() { return null } })`,
      ),
    ])

    await controller.reload()

    expect(extensions.get("panel")).toEqual([])
    expect(extensions.get("surface")).toEqual([])
    expect(extensions.get("settingsPage")).toEqual([])
    expect(controller.errors.get()).toMatchObject([
      {
        pluginId: "ui.panel",
        kind: "apply",
        detail: expect.stringContaining("Component must be a React component"),
      },
      {
        pluginId: "ui.surface",
        kind: "apply",
        detail: expect.stringContaining("Component must be a React component"),
      },
      {
        pluginId: "ui.page",
        kind: "apply",
        detail: expect.stringContaining("title must be a string"),
      },
    ])
    controller.dispose()
  })

  it("registers a plugin's Command under the plugin's owner and drops it when the plugin is disabled", async () => {
    const { extensions, controller } = setup()
    serve([
      entry(
        "ui.cmd",
        `const dispose = ctx.commands.register({
          id: "debug-run",
          title: "Run the sample command",
          keywords: ["debug"],
          icon: "spark",
          shortcut: "Mod+Shift+d",
          slash: "debug",
          available: () => true,
          run() {},
        })
        return dispose`,
      ),
    ])

    await controller.reload()

    expect(extensions.get("command")).toMatchObject([
      {
        id: "debug-run",
        owner: { kind: "plugin", id: "ui.cmd" },
        order: 0,
        title: { text: "Run the sample command" },
        keywords: ["debug"],
        icon: "spark",
        shortcut: "Mod+Shift+d",
        slash: "debug",
      },
    ])
    expect(extensions.get("command")[0]?.available?.()).toBe(true)

    // 插件没有在清理函数里注销：停用后按 owner 一并移除。
    serve([])
    await controller.reload()
    expect(extensions.get("command")).toEqual([])
    controller.dispose()
  })

  it("rejects a Command with a missing id, title or run, or a slash with spaces, instead of registering it", async () => {
    const { extensions, controller } = setup()
    vi.spyOn(console, "error").mockImplementation(() => {})
    const command = (body: string) => `ctx.commands.register({ ${body} })`
    serve([
      entry("ui.id", command(`title: "T", run() {}`)),
      entry("ui.title", command(`id: "c", run() {}`)),
      entry("ui.run", command(`id: "c", title: "T"`)),
      entry("ui.slash", command(`id: "c", title: "T", slash: "two words", run() {}`)),
      entry("ui.keywords", command(`id: "c", title: "T", keywords: [1], run() {}`)),
    ])

    await controller.reload()

    expect(extensions.get("command")).toEqual([])
    expect(controller.errors.get()).toMatchObject([
      { pluginId: "ui.id", kind: "apply", detail: expect.stringContaining("id must be") },
      { pluginId: "ui.title", kind: "apply", detail: expect.stringContaining("title must be") },
      { pluginId: "ui.run", kind: "apply", detail: expect.stringContaining("run must be") },
      { pluginId: "ui.slash", kind: "apply", detail: expect.stringContaining("slash must be") },
      {
        pluginId: "ui.keywords",
        kind: "apply",
        detail: expect.stringContaining("keywords must be an array of strings"),
      },
    ])
    controller.dispose()
  })
  it("keeps a Command whose / name is taken, warning instead of stopping the plugin", async () => {
    const { extensions, controller } = setup()
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
    extensions.register("command", {
      id: "new-thread",
      owner: { kind: "builtin", id: "shell" },
      order: -60,
      title: { text: "New chat" },
      slash: "new",
      run() {},
    })
    serve([
      entry(
        "ui.new",
        `ctx.commands.register({ id: "mine", title: "Mine", slash: "New", run() {} })
        ctx.commands.register({ id: "after", title: "After", run() {} })`,
      ),
    ])

    await controller.reload()

    // 后面的登记照常进行；`/` 建议里谁显示由排序决定（内置命令在前）。
    expect(extensions.get("command").map((command) => command.id)).toEqual([
      "new-thread",
      "after",
      "mine",
    ])
    expect(controller.errors.get()).toEqual([])
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('/New is already used by the command "new-thread"'),
    )
    controller.dispose()
  })

  it("drops a Command error that arrives after its plugin was disabled", async () => {
    const { extensions, controller } = setup()
    vi.spyOn(console, "error").mockImplementation(() => {})
    serve([
      entry(
        "ui.late",
        `ctx.commands.register({ id: "slow", title: "Slow", async run() {
          await new Promise((resolve) => setTimeout(resolve, 10))
          throw new Error("too late")
        } })`,
      ),
    ])
    await controller.reload()
    const running = extensions.get("command")[0]!.run()

    serve([])
    await controller.reload()
    await running
    await Promise.resolve()

    expect(controller.errors.get()).toEqual([])
    controller.dispose()
  })

  it("records errors thrown by a Command's run or available as the plugin's, not the host's", async () => {
    const { extensions, controller } = setup()
    vi.spyOn(console, "error").mockImplementation(() => {})
    serve([
      entry(
        "ui.bad",
        `ctx.commands.register({ id: "sync", title: "Sync", run() { throw new Error("boom") } })
        ctx.commands.register({ id: "async", title: "Async", async run() { throw new Error("later") } })
        ctx.commands.register({ id: "gate", title: "Gate", available() { throw new Error("gate") }, run() {} })`,
      ),
    ])
    await controller.reload()
    const byId = (id: string) => extensions.get("command").find((command) => command.id === id)!

    await expect(byId("sync").run()).resolves.toBeUndefined()
    await expect(byId("async").run()).resolves.toBeUndefined()
    expect(byId("gate").available?.()).toBe(false)
    await Promise.resolve()

    expect(controller.errors.get()).toMatchObject([
      { pluginId: "ui.bad", kind: "command", detail: "sync: boom" },
      { pluginId: "ui.bad", kind: "command", detail: "async: later" },
      { pluginId: "ui.bad", kind: "command", detail: "gate: gate" },
    ])
    // 停用插件后这些错误一并清掉。
    serve([])
    await controller.reload()
    expect(controller.errors.get()).toEqual([])
    controller.dispose()
  })
})
