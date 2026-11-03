// @vitest-environment jsdom
/**
 * 验证插件的设置页：登记到设置页扩展点并归属到插件、和内置页重名时记成冲突、插件更新时不中断；
 * 以及缺了标题或 render 的 Panel、Surface、设置页登记被拒绝并记成插件的界面代码错误。
 */
import { render, screen } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"
import type { ClientModule } from "@pigcode/client-runtime"
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
    const { extensions, controller } = setup()
    // 内置设置页只登记，内容不渲染，用不到这些依赖。
    registerBuiltinSettingsPages(extensions, {} as CoreDeps)
    vi.spyOn(console, "error").mockImplementation(() => {})
    const settingsPage = (id: string, title: string) =>
      `ctx.settingsPages.register({
        id: ${JSON.stringify(id)},
        title: ${JSON.stringify(title)},
        order: 3,
        render(container) {
          container.append(ctx.ui.row({ title: "Verbose", control: ctx.ui.toggle({ label: "Verbose", checked: false }) }))
        },
      })`
    serve([
      entry(
        "ui.debug",
        settingsPage("debug-settings", "Debug Settings") + "\n" + settingsPage("general", "Mine"),
      ),
    ])

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
    expect(content?.className).toBe("pg-root pg-settings")
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
      `ctx.settingsPages.register({ id: "p", title: ${JSON.stringify(title)}, render() {} })`
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

  it("reports a Panel, Surface or settings page with a missing title or render instead of registering it", async () => {
    const { extensions, controller } = setup()
    vi.spyOn(console, "error").mockImplementation(() => {})
    serve([
      entry("ui.panel", `ctx.panels.register({ id: "p", render() {} })`),
      entry("ui.surface", `ctx.surfaces.register({ id: "s", title: "S" })`),
      entry("ui.page", `ctx.settingsPages.register({ id: "g", title: 3, render() {} })`),
    ])

    await controller.reload()

    expect(extensions.get("panel")).toEqual([])
    expect(extensions.get("surface")).toEqual([])
    expect(extensions.get("settingsPage")).toEqual([])
    expect(controller.errors.get()).toMatchObject([
      {
        pluginId: "ui.panel",
        kind: "apply",
        detail: expect.stringContaining("title must be a string"),
      },
      {
        pluginId: "ui.surface",
        kind: "apply",
        detail: expect.stringContaining("render must be a function"),
      },
      {
        pluginId: "ui.page",
        kind: "apply",
        detail: expect.stringContaining("title must be a string"),
      },
    ])
    controller.dispose()
  })
})
