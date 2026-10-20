/** 验证 Base UI Switch 的受控切换。 */
// @vitest-environment jsdom
import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { useState } from "react"
import { describe, expect, it } from "vitest"
import { Switch } from "./switch"

function Controlled() {
  const [checked, setChecked] = useState(false)
  return <Switch checked={checked} onCheckedChange={setChecked} aria-label="深色模式" />
}

describe("Switch", () => {
  it("toggles", async () => {
    render(<Controlled />)
    const control = screen.getByRole("switch", { name: "深色模式" })
    await userEvent.click(control)
    expect(control.getAttribute("aria-checked")).toBe("true")
  })
})
