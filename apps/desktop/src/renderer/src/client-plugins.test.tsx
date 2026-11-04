// @vitest-environment jsdom
/**
 * 验证第三方 UI 插件：Panel 与 Surface 登记到扩展点注册表并归属到插件，和已有 id 冲突时不覆盖；
 * 插件从 boot graph 消失时按 owner 移除，其余插件不动；slot 登记函数已删除。
 */
import { afterEach, describe, expect, it, vi } from "vitest"
import type { ClientModule } from "@pigcode/client-runtime"
import { registerBuiltinSurfaces } from "./builtin-surfaces"
import { deferred, entry, serve, setup, surfaceCall } from "./client-plugins.fixtures"

// builtin-surfaces 只从工作台包里取文件标签的种类；整个包会加载 xterm，jsdom 里没有 canvas。
vi.mock("@pigcode/ui-workbench", () => ({ FILE_SURFACE_KIND: "file" }))

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe("the removed slot API", () => {
  it("records an apply error for a bundle that still calls ctx.slots, and keeps the rest", async () => {
    const { extensions, controller } = setup()
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {})
    serve([
      entry(
        "ui.old",
        `ctx.panels.register({ id: "status", title: "Status", render() {} })
        ctx.slots.register("status.bar", { id: "status", render: () => null })`,
      ),
    ])

    await controller.reload()

    // slot 登记函数已删除：旧插件在这一步抛错，同一插件里先登记的 Panel 照常生效。
    expect(extensions.get("panel").map((panel) => panel.id)).toEqual(["status"])
    expect(controller.errors.get()).toMatchObject([{ pluginId: "ui.old", kind: "apply" }])
    expect(consoleError).toHaveBeenCalledWith(expect.stringContaining("ui.old"))
    controller.dispose()
  })
})

describe("client plugin panels and surfaces", () => {
  it("registers Panels and Surfaces owned by the plugin, built with the host's ui kit", async () => {
    const { extensions, controller } = setup()
    serve([
      entry(
        "ui.inspector",
        `ctx.surfaces.register({
          id: "inspector",
          title: "Inspector",
          description: "Host state",
          render(container) {
            container.append(ctx.ui.row({ title: ctx.theme.get(), control: ctx.ui.badge(ctx.locale.get()) }))
          },
        })
        ctx.panels.register({ id: "status", title: "Status", order: 5, render() {} })`,
      ),
    ])
    document.documentElement.setAttribute("data-theme", "dark")
    document.documentElement.setAttribute("lang", "en-US")

    await controller.reload()

    const [surface] = extensions.get("surface")
    expect(surface).toMatchObject({
      id: "inspector",
      owner: { kind: "plugin", id: "ui.inspector" },
      order: 0,
      title: { text: "Inspector" },
      description: { text: "Host state" },
    })
    expect(extensions.get("panel")).toMatchObject([
      { id: "status", owner: { kind: "plugin", id: "ui.inspector" }, order: 5 },
    ])
    controller.dispose()
    expect(extensions.get("surface")).toEqual([])
    expect(extensions.get("panel")).toEqual([])
  })

  it("rejects a Surface whose id a built-in or another plugin already has, naming both owners", async () => {
    const { extensions, controller } = setup()
    registerBuiltinSurfaces(extensions)
    vi.spyOn(console, "error").mockImplementation(() => {})
    const surface = (id: string, title: string) =>
      `ctx.surfaces.register({ id: ${JSON.stringify(id)}, title: ${JSON.stringify(title)}, render() {} })`
    serve([
      entry("ui.a", surface("terminal", "Fake terminal") + "\n" + surface("shared", "A")),
      entry("ui.b", surface("shared", "B")),
    ])

    await controller.reload()

    const surfaces = extensions.get("surface")
    expect(surfaces.find((item) => item.id === "terminal")?.owner).toEqual({
      kind: "builtin",
      id: "workbench",
    })
    expect(surfaces.find((item) => item.id === "shared")?.title).toEqual({ text: "A" })
    expect(extensions.conflicts()).toEqual([
      {
        point: "surface",
        id: "terminal",
        existing: { kind: "builtin", id: "workbench" },
        rejected: { kind: "plugin", id: "ui.a" },
      },
      {
        point: "surface",
        id: "shared",
        existing: { kind: "plugin", id: "ui.a" },
        rejected: { kind: "plugin", id: "ui.b" },
      },
    ])

    // ui.b 停用：它的冲突记录随之清除，ui.a 的登记不受影响。
    serve([entry("ui.a", surface("terminal", "Fake terminal") + "\n" + surface("shared", "A"))])
    await controller.reload()
    expect(extensions.conflicts().map((conflict) => conflict.rejected.id)).toEqual(["ui.a"])
    controller.dispose()
  })

  it("removes only the disabled plugin's contributions on reload and keeps the others in place", async () => {
    const { extensions, controller } = setup()
    const panel = (id: string) =>
      `ctx.panels.register({ id: ${JSON.stringify(id)}, title: ${JSON.stringify(id)}, render() {} })`
    const keep = entry("ui.keep", panel("keep"))
    // 插件没有在清理函数里注销自己的 Surface：卸载时按 owner 一并移除。
    const gone = entry(
      "ui.gone",
      `${panel("gone")}
      ctx.surfaces.register({ id: "gone-surface", title: "Gone", render() {} })
      return () => {}`,
    )
    serve([keep, gone])
    await controller.reload()
    const kept = extensions.get("panel").find((item) => item.id === "keep")
    expect(extensions.get("panel").map((item) => item.id)).toEqual(["gone", "keep"])
    expect(extensions.get("surface").map((item) => item.id)).toEqual(["gone-surface"])

    serve([keep])
    await controller.reload()
    expect(extensions.get("panel").map((item) => item.id)).toEqual(["keep"])
    // 没有停用的插件不会重新应用：仍是同一个 Contribution。
    expect(extensions.get("panel")[0]).toBe(kept)
    expect(extensions.get("surface")).toEqual([])

    // 换了版本的插件重新应用。
    serve([entry("ui.keep", panel("keep"), "2")])
    await controller.reload()
    expect(extensions.get("panel")[0]).not.toBe(kept)
    controller.dispose()
  })

  it("rejects a Surface with a reserved tab kind as a conflict with the Workbench", async () => {
    const { extensions, controller } = setup()
    registerBuiltinSurfaces(extensions)
    vi.spyOn(console, "error").mockImplementation(() => {})
    serve([entry("ui.a", surfaceCall("file", "Not a file"))])

    await controller.reload()

    expect(extensions.get("surface").map((item) => item.id)).not.toContain("file")
    expect(extensions.conflicts()).toEqual([
      {
        point: "surface",
        id: "file",
        existing: { kind: "builtin", id: "workbench" },
        rejected: { kind: "plugin", id: "ui.a" },
      },
    ])
    controller.dispose()
  })

  it("gives the id to a plugin it was rejected for once the winner is disabled", async () => {
    const { extensions, controller } = setup()
    vi.spyOn(console, "error").mockImplementation(() => {})
    const panel = `ctx.panels.register({ id: "status", title: "Status", render() {} })`
    const a = entry("ui.a", `${surfaceCall("x", "A")}\n${panel}`)
    const b = entry("ui.b", `${surfaceCall("x", "B")}\n${panel}`)
    serve([a, b])
    await controller.reload()
    expect(extensions.get("surface")).toMatchObject([{ id: "x", title: { text: "A" } }])
    expect(extensions.conflicts().map((conflict) => `${conflict.point}:${conflict.id}`)).toEqual([
      "surface:x",
      "panel:status",
    ])

    // 停用 A：B 重新应用，拿到 Surface 与 Panel，冲突记录随之清掉。
    serve([b])
    await controller.reload()
    expect(extensions.get("surface")).toMatchObject([
      { id: "x", title: { text: "B" }, owner: { kind: "plugin", id: "ui.b" } },
    ])
    expect(extensions.get("panel").map((item) => item.id)).toEqual(["status"])
    expect(extensions.conflicts()).toEqual([])
    controller.dispose()
  })

  it("reports a bundle that fails to import and retries it on the next reload", async () => {
    let fail = true
    const importModule = vi.fn(async (url: string) => {
      if (fail) throw new Error(`cannot load ${url}`)
      return (await import(/* @vite-ignore */ url)) as ClientModule
    })
    const { extensions, controller } = setup(importModule)
    vi.spyOn(console, "error").mockImplementation(() => {})
    serve([entry("ui.a", surfaceCall("a", "A"))])

    await controller.reload()
    expect(extensions.get("surface")).toEqual([])
    expect(controller.errors.get()).toMatchObject([
      { pluginId: "ui.a", kind: "import", detail: expect.stringContaining("cannot load") },
    ])

    fail = false
    await controller.reload()
    expect(importModule).toHaveBeenCalledTimes(2)
    expect(extensions.get("surface").map((item) => item.id)).toEqual(["a"])
    expect(controller.errors.get()).toEqual([])
    controller.dispose()
  })

  it("finishes a pending reload when a later reload cannot read the boot graph", async () => {
    const gate = deferred<void>()
    const { extensions, controller } = setup(async (url) => {
      if (url.includes("B%22")) await gate.promise
      return (await import(/* @vite-ignore */ url)) as ClientModule
    })
    serve([entry("ui.a", surfaceCall("a", "A"), "1")])
    await controller.reload()

    // 第一次 reload 正在等新版本 import；第二次读 boot graph 失败。
    serve([entry("ui.a", surfaceCall("a", "B"), "2")])
    const updating = controller.reload()
    vi.stubGlobal("fetch", async () => {
      throw new Error("offline")
    })
    await controller.reload()
    gate.resolve()
    await updating

    expect(extensions.get("surface")).toMatchObject([{ id: "a", title: { text: "B" } }])
    controller.dispose()
  })

  it("keeps a plugin's Surface registered while its new revision loads, so open tabs survive", async () => {
    const gate = deferred<void>()
    const { extensions, controller } = setup(async (url) => {
      if (url.includes("v2")) await gate.promise
      return (await import(/* @vite-ignore */ url)) as ClientModule
    })
    serve([entry("ui.a", surfaceCall("a", "v1"), "1")])
    await controller.reload()

    // React 在微任务里读取快照：记下每次变化之后、下一个微任务里看到的 Surface。
    const seen: string[][] = []
    extensions.subscribe("surface", () =>
      queueMicrotask(() => seen.push(extensions.get("surface").map((item) => item.id))),
    )
    serve([entry("ui.a", surfaceCall("a", "v2"), "2")])
    const updating = controller.reload()
    await new Promise((done) => setTimeout(done, 10))
    expect(extensions.get("surface")).toMatchObject([{ id: "a", title: { text: "v1" } }])
    gate.resolve()
    await updating

    expect(extensions.get("surface")).toMatchObject([{ id: "a", title: { text: "v2" } }])
    expect(seen.length).toBeGreaterThan(0)
    expect(seen.every((ids) => ids.includes("a"))).toBe(true)

    // 停用照样移除。
    serve([])
    await controller.reload()
    expect(extensions.get("surface")).toEqual([])
    controller.dispose()
  })
})
