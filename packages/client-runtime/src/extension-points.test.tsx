/** 验证扩展点注册表：登记、排序、注销、冲突（不覆盖、记下双方）、按 owner 清理与 React 读取。 */
// @vitest-environment jsdom
import { act, cleanup, render, screen } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"
import {
  BUILTIN_TOOL_RENDERER_ORDER,
  EXTENSION_POINTS,
  ExtensionRegistryScope,
  createExtensionRegistry,
  useContributionConflicts,
  useContributions,
  type ContributionOwner,
  type PanelContribution,
  type ToolRendererContribution,
} from "./extension-points"

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

const WORKBENCH: ContributionOwner = { kind: "builtin", id: "workbench" }
const PLUGIN_A: ContributionOwner = { kind: "plugin", id: "ui.a" }
const PLUGIN_B: ContributionOwner = { kind: "plugin", id: "ui.b" }

function panel(id: string, owner: ContributionOwner, order = 0): PanelContribution {
  return { id, owner, order, title: { text: id }, render: () => id }
}

describe("extension registry", () => {
  it("has exactly the five extension points", () => {
    expect(EXTENSION_POINTS).toEqual([
      "panel",
      "surface",
      "settingsPage",
      "command",
      "toolRenderer",
    ])
  })

  it("sorts contributions by order, then id, and notifies only that point's subscribers", () => {
    const registry = createExtensionRegistry()
    const onPanel = vi.fn()
    const onCommand = vi.fn()
    registry.subscribe("panel", onPanel)
    registry.subscribe("command", onCommand)

    registry.register("panel", panel("b", PLUGIN_A, 10))
    registry.register("panel", panel("c", PLUGIN_A, 0))
    registry.register("panel", panel("a", PLUGIN_B, 10))

    expect(registry.get("panel").map((item) => item.id)).toEqual(["c", "a", "b"])
    expect(onPanel).toHaveBeenCalledTimes(3)
    expect(onCommand).not.toHaveBeenCalled()
    expect(registry.get("surface")).toEqual([])
  })

  it("keeps the same snapshot until something changes", () => {
    const registry = createExtensionRegistry()
    registry.register("panel", panel("a", PLUGIN_A))
    const first = registry.get("panel")
    expect(registry.get("panel")).toBe(first)
    registry.register("panel", panel("b", PLUGIN_A))
    expect(registry.get("panel")).not.toBe(first)
  })

  it("unregisters with the returned function, once", () => {
    const registry = createExtensionRegistry()
    const listener = vi.fn()
    const dispose = registry.register("panel", panel("a", PLUGIN_A))
    registry.subscribe("panel", listener)

    dispose()
    dispose()
    expect(registry.get("panel")).toEqual([])
    expect(listener).toHaveBeenCalledOnce()
  })

  it("rejects a duplicate id on the same point without overwriting and records both owners", () => {
    const registry = createExtensionRegistry()
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {})
    const original = panel("shared", WORKBENCH)
    registry.register("panel", original)

    const dispose = registry.register("panel", panel("shared", PLUGIN_A))

    expect(registry.get("panel")).toEqual([original])
    expect(registry.conflicts()).toEqual([
      { point: "panel", id: "shared", existing: WORKBENCH, rejected: PLUGIN_A },
    ])
    expect(consoleError).toHaveBeenCalledWith(expect.stringContaining("builtin:workbench"))
    expect(consoleError).toHaveBeenCalledWith(expect.stringContaining("plugin:ui.a"))
    // 被拒绝一方拿到的注销函数什么也不做，不会删掉先登记的那项。
    dispose()
    expect(registry.get("panel")).toEqual([original])
  })

  it("rejects a reserved id as a conflict with the reserving owner, without listing it", () => {
    const registry = createExtensionRegistry()
    vi.spyOn(console, "error").mockImplementation(() => {})
    const unreserve = registry.reserve("surface", "file", WORKBENCH)
    const surface = {
      id: "file",
      owner: PLUGIN_A,
      order: 0,
      title: { text: "File" },
      icon: () => null,
      render: () => null,
    }

    registry.register("surface", surface)
    expect(registry.get("surface")).toEqual([])
    expect(registry.conflicts()).toEqual([
      { point: "surface", id: "file", existing: WORKBENCH, rejected: PLUGIN_A },
    ])

    unreserve()
    registry.register("surface", surface)
    expect(registry.get("surface")).toEqual([surface])
  })

  it("allows the same id on different points", () => {
    const registry = createExtensionRegistry()
    registry.register("panel", panel("shared", PLUGIN_A))
    registry.register("command", {
      id: "shared",
      owner: PLUGIN_B,
      order: 0,
      title: { text: "Shared" },
      run: () => undefined,
    })
    expect(registry.get("command").map((item) => item.id)).toEqual(["shared"])
    expect(registry.conflicts()).toEqual([])
  })

  it("does not let a stale unregister remove a later contribution with the same id", () => {
    const registry = createExtensionRegistry()
    const dispose = registry.register("panel", panel("a", PLUGIN_A))
    dispose()
    const later = panel("a", PLUGIN_B)
    registry.register("panel", later)
    dispose()
    expect(registry.get("panel")).toEqual([later])
  })

  it("removes everything an owner contributed, and its rejected registrations, on every point", () => {
    const registry = createExtensionRegistry()
    vi.spyOn(console, "error").mockImplementation(() => {})
    registry.register("panel", panel("a1", PLUGIN_A))
    registry.register("panel", panel("b1", PLUGIN_B))
    registry.register("panel", panel("builtin", WORKBENCH))
    registry.register("command", {
      id: "a-command",
      owner: PLUGIN_A,
      order: 0,
      title: { text: "A" },
      run: () => undefined,
    })
    registry.register("panel", panel("builtin", PLUGIN_A))
    registry.register("panel", panel("a1", PLUGIN_B))
    const onPanel = vi.fn()
    const onSurface = vi.fn()
    const onConflicts = vi.fn()
    registry.subscribe("panel", onPanel)
    registry.subscribe("surface", onSurface)
    registry.subscribeConflicts(onConflicts)

    registry.removeOwner(PLUGIN_A)

    expect(registry.get("panel").map((item) => item.id)).toEqual(["b1", "builtin"])
    expect(registry.get("command")).toEqual([])
    expect(onPanel).toHaveBeenCalledOnce()
    expect(onSurface).not.toHaveBeenCalled()
    // ui.a 被拒绝的记录清掉；ui.b 被 ui.a 拒绝的记录保留：ui.b 并没有因此得到这个 id，
    // 要等插件控制器重新应用 ui.b（见 client-plugins 的 reload），记录才随 ui.b 的卸载清掉。
    expect(registry.conflicts()).toEqual([
      { point: "panel", id: "a1", existing: PLUGIN_A, rejected: PLUGIN_B },
    ])
    expect(onConflicts).toHaveBeenCalledOnce()
  })
})

describe("tool renderers", () => {
  function renderer(
    id: string,
    owner: ContributionOwner,
    order: number,
    match: (name: string) => boolean,
  ): ToolRendererContribution {
    return { id, owner, order, matches: match, render: () => id }
  }

  /** 时间线的选择规则：按注册表的顺序，第一个匹配的生效。 */
  const pick = (registry: ReturnType<typeof createExtensionRegistry>, name: string) =>
    registry.get("toolRenderer").find((item) => item.matches(name))?.id

  it("lets a plugin at the default order beat the built-in that matches every MCP name", () => {
    const registry = createExtensionRegistry()
    const isMcp = (name: string) => name.startsWith("mcp__")
    registry.register(
      "toolRenderer",
      renderer("builtin.mcp", WORKBENCH, BUILTIN_TOOL_RENDERER_ORDER, isMcp),
    )
    const dispose = registry.register(
      "toolRenderer",
      renderer("clock", PLUGIN_A, 0, (name) => name.endsWith("clock_now")),
    )
    expect(pick(registry, "mcp__pigcode__clock_now")).toBe("clock")
    expect(pick(registry, "mcp__github__list_issues")).toBe("builtin.mcp")
    // 没有匹配时列表里什么也选不到，时间线用通用渲染器。
    expect(pick(registry, "frob_widget")).toBeUndefined()

    dispose()
    expect(pick(registry, "mcp__pigcode__clock_now")).toBe("builtin.mcp")
  })

  it("puts a plugin after the built-ins when its order is larger, and removes it with its owner", () => {
    const registry = createExtensionRegistry()
    const any = () => true
    registry.register(
      "toolRenderer",
      renderer("builtin.mcp", WORKBENCH, BUILTIN_TOOL_RENDERER_ORDER, any),
    )
    registry.register("toolRenderer", renderer("late", PLUGIN_A, 2000, any))
    registry.register("toolRenderer", renderer("early", PLUGIN_B, -1, any))
    expect(registry.get("toolRenderer").map((item) => item.id)).toEqual([
      "early",
      "builtin.mcp",
      "late",
    ])
    registry.removeOwner(PLUGIN_B)
    expect(pick(registry, "anything")).toBe("builtin.mcp")
  })
})

describe("useContributions", () => {
  function Panels() {
    const panels = useContributions("panel")
    const conflicts = useContributionConflicts()
    return (
      <p>
        {panels.map((item) => item.id).join(",") || "none"} / {conflicts.length}
      </p>
    )
  }

  it("re-renders with the registry snapshot and is empty outside a scope", () => {
    const registry = createExtensionRegistry()
    vi.spyOn(console, "error").mockImplementation(() => {})
    render(
      <ExtensionRegistryScope registry={registry}>
        <Panels />
      </ExtensionRegistryScope>,
    )
    expect(screen.getByText("none / 0")).toBeTruthy()

    act(() => {
      registry.register("panel", panel("b", PLUGIN_A))
      registry.register("panel", panel("a", PLUGIN_A))
    })
    expect(screen.getByText("a,b / 0")).toBeTruthy()

    act(() => {
      registry.register("panel", panel("a", PLUGIN_B))
    })
    expect(screen.getByText("a,b / 1")).toBeTruthy()

    act(() => registry.removeOwner(PLUGIN_A))
    expect(screen.getByText("none / 1")).toBeTruthy()
    cleanup()

    render(<Panels />)
    expect(screen.getByText("none / 0")).toBeTruthy()
  })
})
