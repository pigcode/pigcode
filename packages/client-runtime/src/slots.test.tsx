/** 验证 slot 注册、排序、渲染与卸载。 */
// @vitest-environment jsdom
import { render, screen } from "@testing-library/react"
import type { ClientSlotApi } from "@pigcode/plugin-sdk"
import { describe, expect, it } from "vitest"
import { createSlotRegistry, SlotHost } from "./slots"

describe("slots", () => {
  it("renders a registered slot", () => {
    const registry = createSlotRegistry()
    const dispose = registry.register("sidebar.section", {
      id: "demo",
      order: 10,
      render: () => <div>Demo panel</div>,
    })
    render(<SlotHost registry={registry} name="sidebar.section" />)
    expect(screen.getByText("Demo panel")).toBeTruthy()
    dispose()
  })

  it("sorts entries by order and removes them on dispose", () => {
    const registry = createSlotRegistry()
    registry.register("sidebar.section", { id: "later", order: 20, render: () => null })
    const dispose = registry.register("sidebar.section", {
      id: "earlier",
      order: 10,
      render: () => null,
    })

    expect(registry.get("sidebar.section").map((entry) => entry.id)).toEqual(["earlier", "later"])

    dispose()
    expect(registry.get("sidebar.section").map((entry) => entry.id)).toEqual(["later"])
  })

  it("implements the plugin-facing slot facade", () => {
    const registry: ClientSlotApi = createSlotRegistry()
    expect(registry.register("sidebar.section", { id: "plugin", render: () => null })).toBeTypeOf(
      "function",
    )
  })
})
