/** 验证搜索框的结构、无障碍名称、输入回调、清除按钮与右侧元素。 */
// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { useState } from "react"
import { afterEach, describe, expect, it, vi } from "vitest"
import { SearchField, type SearchFieldProps } from "./search-field"

afterEach(() => cleanup())

/** 受控的搜索框：值放在组件状态里，onValueChange 同时交给测试。 */
function Controlled(props: Partial<SearchFieldProps> & { initial?: string }) {
  const { initial = "", onValueChange, ...rest } = props
  const [value, setValue] = useState(initial)
  return (
    <SearchField
      placeholder="搜索设置"
      {...rest}
      value={value}
      onValueChange={(next) => {
        setValue(next)
        onValueChange?.(next)
      }}
    />
  )
}

describe("SearchField", () => {
  it("renders a label with the icon, a search input and the size", () => {
    const { container } = render(<Controlled className="extra" />)
    const root = container.firstElementChild as HTMLElement
    expect(root.tagName).toBe("LABEL")
    expect(root.className).toBe("search-field extra")
    expect(root.getAttribute("data-size")).toBe("default")
    expect(root.firstElementChild?.tagName.toLowerCase()).toBe("svg")
    expect(root.firstElementChild?.getAttribute("aria-hidden")).toBe("true")
    const input = screen.getByRole("searchbox") as HTMLInputElement
    expect(input.type).toBe("search")
    expect(input.getAttribute("autocomplete")).toBe("off")
    expect(input.getAttribute("spellcheck")).toBe("false")
  })

  it("marks the compact size", () => {
    const { container } = render(<Controlled size="compact" />)
    expect((container.firstElementChild as HTMLElement).getAttribute("data-size")).toBe("compact")
  })

  it("marks the plain variant used at the top of popups", () => {
    const { container } = render(<Controlled />)
    expect((container.firstElementChild as HTMLElement).getAttribute("data-variant")).toBe(
      "default",
    )
    cleanup()
    const plain = render(<Controlled variant="plain" />)
    expect((plain.container.firstElementChild as HTMLElement).getAttribute("data-variant")).toBe(
      "plain",
    )
  })

  it("names the input after the placeholder unless aria-label is given", () => {
    render(<Controlled />)
    expect(screen.getByRole("searchbox", { name: "搜索设置" })).toBeTruthy()
    cleanup()
    render(<Controlled aria-label="搜索文件" />)
    const input = screen.getByRole("searchbox", { name: "搜索文件" }) as HTMLInputElement
    expect(input.placeholder).toBe("搜索设置")
  })

  it("reports each change through onValueChange", async () => {
    const onValueChange = vi.fn()
    render(<Controlled onValueChange={onValueChange} />)
    await userEvent.type(screen.getByRole("searchbox"), "ab")
    expect(onValueChange.mock.calls).toEqual([["a"], ["ab"]])
  })

  it("shows the clear button only with a value and clearLabel", async () => {
    render(<Controlled />)
    await userEvent.type(screen.getByRole("searchbox"), "x")
    expect(screen.queryByRole("button")).toBeNull()
    cleanup()

    render(<Controlled clearLabel="清除搜索" />)
    expect(screen.queryByRole("button", { name: "清除搜索" })).toBeNull()
    await userEvent.type(screen.getByRole("searchbox"), "x")
    expect(screen.getByRole("button", { name: "清除搜索" })).toBeTruthy()
  })

  it("clears the value and refocuses the input", async () => {
    const onValueChange = vi.fn()
    render(<Controlled initial="外观" clearLabel="清除搜索" onValueChange={onValueChange} />)
    await userEvent.click(screen.getByRole("button", { name: "清除搜索" }))
    const input = screen.getByRole("searchbox") as HTMLInputElement
    expect(onValueChange).toHaveBeenLastCalledWith("")
    expect(input.value).toBe("")
    expect(document.activeElement).toBe(input)
    expect(screen.queryByRole("button", { name: "清除搜索" })).toBeNull()
  })

  it("renders the trailing element last and forwards the input ref and key handler", async () => {
    const ref = { current: null as HTMLInputElement | null }
    const onKeyDown = vi.fn()
    const { container } = render(
      <Controlled
        initial="a"
        clearLabel="清除搜索"
        inputRef={ref}
        onKeyDown={onKeyDown}
        trailing={<kbd>esc</kbd>}
      />,
    )
    const root = container.firstElementChild as HTMLElement
    expect(root.lastElementChild?.tagName).toBe("KBD")
    expect(root.lastElementChild?.previousElementSibling?.className).toBe("search-field-clear")
    expect(ref.current).toBe(screen.getByRole("searchbox"))
    await userEvent.type(screen.getByRole("searchbox"), "{Enter}")
    expect(onKeyDown).toHaveBeenCalledWith(expect.objectContaining({ key: "Enter" }))
  })
})
