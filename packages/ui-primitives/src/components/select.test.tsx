/** 验证 Base UI Select 选择选项。 */
// @vitest-environment jsdom
import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { useState } from "react"
import { describe, expect, it } from "vitest"
import { Select } from "./select"

function Controlled() {
  const [value, setValue] = useState("claude")
  return (
    <Select.Root value={value} onValueChange={(next) => setValue(String(next))}>
      <Select.Trigger aria-label="Agent">{value}</Select.Trigger>
      <Select.Portal>
        <Select.Positioner>
          <Select.Popup>
            <Select.Item value="claude">Claude Code</Select.Item>
            <Select.Item value="codex">Codex</Select.Item>
          </Select.Popup>
        </Select.Positioner>
      </Select.Portal>
    </Select.Root>
  )
}

describe("Select", () => {
  it("selects an option", async () => {
    render(<Controlled />)
    await userEvent.click(screen.getByRole("combobox", { name: "Agent" }))
    await userEvent.click(screen.getByText("Codex"))
    expect(screen.getByRole("combobox", { name: "Agent" }).textContent).toContain("codex")
  })
})
