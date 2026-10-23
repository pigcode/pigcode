// @vitest-environment jsdom
/** 验证第三方 UI 插件重复 slot id 时跳过并记录错误，不静默覆盖。 */
import { afterEach, describe, expect, it, vi } from "vitest"
import { Connection, createSlotRegistry } from "@pigcode/client-runtime"
import { createClientPluginController } from "./client-plugins"

/** 生成一个只注册单个 slot 条目的 client bundle data URL。 */
function clientModule(slot: string, id: string): string {
  const source = `export function apply(ctx) {
    ctx.slots.register(${JSON.stringify(slot)}, {
      id: ${JSON.stringify(id)},
      render: () => null,
    })
  }`
  return `data:text/javascript,${encodeURIComponent(source)}`
}

/** 控制器只在 reload 时使用 connection.call，这里不会真正发起 RPC。 */
const connection = new Connection({ onEvent() {}, onDelta() {}, onStatus() {} })

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe("client plugin slot conflicts", () => {
  it("skips a duplicate slot id and records the plugin id", async () => {
    const slots = createSlotRegistry()
    const controller = createClientPluginController({ slots, connection })
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {})
    const boot = {
      entries: [
        {
          id: "ui.a",
          revision: "1",
          inject: [],
          url: clientModule("sidebar.section", "shared"),
        },
        {
          id: "ui.b",
          revision: "1",
          inject: [],
          url: clientModule("sidebar.section", "shared"),
        },
      ],
    }
    vi.stubGlobal("fetch", async () => ({ ok: true, json: async () => boot }))

    await controller.reload()

    // 先注册者保留，后注册者被跳过。
    expect(slots.get("sidebar.section").map((entry) => entry.id)).toEqual(["shared"])
    const errors = controller.errors.get()
    expect(errors).toHaveLength(1)
    expect(errors[0]?.pluginId).toBe("ui.b")
    expect(errors[0]?.message).toContain("SLOT_CONFLICT")
    expect(errors[0]?.message).toContain("ui.a")
    expect(consoleError).toHaveBeenCalledWith(expect.stringContaining("ui.b"))

    controller.dispose()
    expect(slots.get("sidebar.section")).toEqual([])
  })

  it("allows the same id in different slots", async () => {
    const slots = createSlotRegistry()
    const controller = createClientPluginController({ slots, connection })
    const boot = {
      entries: [
        {
          id: "ui.a",
          revision: "1",
          inject: [],
          url: clientModule("sidebar.section", "shared"),
        },
        { id: "ui.b", revision: "1", inject: [], url: clientModule("status.bar", "shared") },
      ],
    }
    vi.stubGlobal("fetch", async () => ({ ok: true, json: async () => boot }))

    await controller.reload()

    expect(slots.get("sidebar.section").map((entry) => entry.id)).toEqual(["shared"])
    expect(slots.get("status.bar").map((entry) => entry.id)).toEqual(["shared"])
    expect(controller.errors.get()).toEqual([])
    controller.dispose()
  })
})

describe("client plugin panels and surfaces", () => {
  it("registers right-panel surfaces built with the host's ui kit and drops them on dispose", async () => {
    const source = `export function apply(ctx) {
      ctx.registerSurface({
        id: "inspector",
        title: "Inspector",
        render(container) {
          container.append(ctx.ui.row({ title: ctx.theme.get(), control: ctx.ui.badge(ctx.locale.get()) }))
        },
      })
      ctx.registerPanel({ id: "status", title: "Status", render() {} })
    }`
    const slots = createSlotRegistry()
    const controller = createClientPluginController({ slots, connection })
    const boot = {
      entries: [
        {
          id: "ui.inspector",
          revision: "1",
          inject: [],
          url: `data:text/javascript,${encodeURIComponent(source)}`,
        },
      ],
    }
    vi.stubGlobal("fetch", async () => ({ ok: true, json: async () => boot }))
    document.documentElement.setAttribute("data-theme", "dark")
    document.documentElement.setAttribute("lang", "en-US")

    await controller.reload()

    const [surface] = controller.surfaces.get()
    expect(surface?.title).toBe("Inspector")
    const container = document.createElement("div")
    surface?.render(container)
    expect(container.querySelector(".pg-row-title")?.textContent).toBe("dark")
    expect(container.querySelector(".badge")?.textContent).toBe("en-US")
    expect(controller.panels.get().map((panel) => panel.id)).toEqual(["status"])
    controller.dispose()
    expect(controller.surfaces.get()).toEqual([])
    expect(controller.panels.get()).toEqual([])
  })
})
