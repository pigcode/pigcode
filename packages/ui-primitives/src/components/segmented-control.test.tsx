/** 验证分段控件：读作单选组，点击与方向键都会选中，选中项带 data-checked。 */
// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { useState } from "react"
import { afterEach, describe, expect, it } from "vitest"
import { SegmentedControl } from "./segmented-control"

afterEach(() => cleanup())

function Mode() {
  const [mode, setMode] = useState<"light" | "dark" | "system">("system")
  return (
    <SegmentedControl
      aria-label="模式"
      value={mode}
      onValueChange={setMode}
      options={[
        { value: "system", label: "跟随系统" },
        { value: "light", label: "浅色" },
        { value: "dark", label: "深色" },
      ]}
    />
  )
}

describe("SegmentedControl", () => {
  it("is a radio group whose items select on click and with arrow keys", async () => {
    render(<Mode />)
    const group = screen.getByRole("radiogroup", { name: "模式" })
    expect(group.className).toBe("seg")
    const light = screen.getByRole("radio", { name: "浅色" })
    expect(light.className).toBe("seg-item")
    expect(screen.getByRole("radio", { name: "跟随系统" }).getAttribute("aria-checked")).toBe(
      "true",
    )

    await userEvent.click(light)
    expect(light.getAttribute("aria-checked")).toBe("true")
    expect(light.hasAttribute("data-checked")).toBe(true)

    await userEvent.keyboard("{ArrowRight}")
    expect(screen.getByRole("radio", { name: "深色" }).getAttribute("aria-checked")).toBe("true")
  })

  it("draws each option as a pill in the pills variant", () => {
    render(
      <SegmentedControl
        aria-label="目录"
        variant="pills"
        className="market-tabs"
        value="public"
        onValueChange={() => {}}
        options={[
          { value: "public", label: "官方" },
          { value: "community", label: "社区" },
        ]}
      />,
    )
    expect(screen.getByRole("radiogroup", { name: "目录" }).className).toBe(
      "seg seg-pills market-tabs",
    )
  })
})
