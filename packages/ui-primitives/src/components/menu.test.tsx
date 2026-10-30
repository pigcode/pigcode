/** 验证菜单与下拉的部件自动带上统一的类名，并保留调用方传入的类名。 */
// @vitest-environment jsdom
import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { describe, expect, it } from "vitest"
import { withBaseClass } from "./base-class"
import { Menu } from "./menu"
import { Select } from "./select"

describe("withBaseClass", () => {
  it("puts the base class before a string or a state function", () => {
    expect(withBaseClass("menu-item", undefined)).toBe("menu-item")
    expect(withBaseClass("menu-item", "danger")).toBe("menu-item danger")
    const byState = withBaseClass<{ highlighted: boolean }>("menu-item", (state) =>
      state.highlighted ? "on" : undefined,
    )
    expect(typeof byState === "function" && byState({ highlighted: true })).toBe("menu-item on")
    expect(typeof byState === "function" && byState({ highlighted: false })).toBe("menu-item")
  })
})

describe("Menu parts", () => {
  it("add the shared menu classes", async () => {
    render(
      <Menu.Root>
        <Menu.Trigger>Open</Menu.Trigger>
        <Menu.Portal>
          <Menu.Positioner>
            <Menu.Popup className="wide">
              <Menu.Group>
                <Menu.Label>Group</Menu.Label>
                <Menu.Item>First</Menu.Item>
              </Menu.Group>
              <Menu.Separator />
              <Menu.Item className="extra">Second</Menu.Item>
            </Menu.Popup>
          </Menu.Positioner>
        </Menu.Portal>
      </Menu.Root>,
    )
    await userEvent.click(screen.getByRole("button", { name: "Open" }))
    const menu = await screen.findByRole("menu")
    expect(menu.classList.contains("popup")).toBe(true)
    expect(menu.classList.contains("menu-popup")).toBe(true)
    expect(menu.classList.contains("wide")).toBe(true)
    expect(menu.closest(".menu-positioner")).not.toBeNull()
    expect(screen.getByRole("menuitem", { name: "First" }).classList.contains("menu-item")).toBe(
      true,
    )
    const second = screen.getByRole("menuitem", { name: "Second" })
    expect(second.classList.contains("menu-item")).toBe(true)
    expect(second.classList.contains("extra")).toBe(true)
    expect(screen.getByRole("separator").classList.contains("menu-sep")).toBe(true)
    expect(screen.getByText("Group").classList.contains("menu-label")).toBe(true)
  })
})

describe("Select parts", () => {
  it("use the same popup and item classes as menus", async () => {
    render(
      <Select.Root defaultValue="claude">
        <Select.Trigger aria-label="Agent">
          <Select.Value />
        </Select.Trigger>
        <Select.Portal>
          <Select.Positioner>
            <Select.Popup>
              <Select.Item value="claude">Claude Code</Select.Item>
              <Select.Item value="codex">Codex</Select.Item>
            </Select.Popup>
          </Select.Positioner>
        </Select.Portal>
      </Select.Root>,
    )
    await userEvent.click(screen.getByRole("combobox", { name: "Agent" }))
    const option = await screen.findByRole("option", { name: "Codex" })
    expect(option.classList.contains("menu-item")).toBe(true)
    expect(option.closest(".popup.menu-popup")).not.toBeNull()
    expect(option.closest(".menu-positioner")).not.toBeNull()
  })
})
