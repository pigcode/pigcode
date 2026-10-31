/** 验证列表行的各部分顺序与类名、选中与紧凑的数据属性，以及主按钮与操作互不干扰。 */
// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { afterEach, describe, expect, it, vi } from "vitest"
import { ListRow } from "./list-row"

afterEach(() => cleanup())

describe("ListRow", () => {
  it("renders the slots in order with their classes", () => {
    const { container } = render(
      <ListRow
        className="extra"
        leading={<i>图标</i>}
        title="标题"
        titleProps={{ className: "own-title", title: "完整标题" }}
        description="说明"
        meta={<time>3分钟</time>}
        actions={<button type="button">操作</button>}
      />,
    )
    const row = container.firstElementChild as HTMLElement
    expect(row.tagName).toBe("DIV")
    expect(row.className).toBe("list-row extra")
    expect(Array.from(row.children).map((child) => child.className)).toEqual([
      "list-row-leading",
      "list-row-text",
      "list-row-meta",
      "list-row-actions",
    ])
    const text = row.querySelector(".list-row-text") as HTMLElement
    expect(Array.from(text.children).map((child) => child.className)).toEqual([
      "list-row-title own-title",
      "list-row-desc",
    ])
    expect(screen.getByText("标题").getAttribute("title")).toBe("完整标题")
    expect(screen.getByText("3分钟").parentElement?.className).toBe("list-row-meta")
    expect(row.hasAttribute("data-interactive")).toBe(false)
  })

  it("puts the title straight in the row without a description and leaves out empty slots", () => {
    const { container } = render(<ListRow title="只有标题" />)
    const row = container.firstElementChild as HTMLElement
    expect(Array.from(row.children).map((child) => child.className)).toEqual(["list-row-title"])
  })

  it("marks selected and compact rows with data attributes", () => {
    const { container, rerender } = render(<ListRow title="行" />)
    const row = () => container.firstElementChild as HTMLElement
    expect(row().hasAttribute("data-selected")).toBe(false)
    expect(row().hasAttribute("data-density")).toBe(false)

    rerender(<ListRow title="行" selected density="compact" />)
    expect(row().hasAttribute("data-selected")).toBe(true)
    expect(row().getAttribute("data-density")).toBe("compact")
  })

  it("renders as the given element and passes element props through", async () => {
    const onClick = vi.fn()
    render(
      <ListRow
        render={<button type="button" />}
        role="option"
        aria-selected
        data-highlighted=""
        onClick={onClick}
        title="新会话"
      />,
    )
    const option = screen.getByRole("option", { name: "新会话" })
    expect(option.tagName).toBe("BUTTON")
    expect(option.getAttribute("type")).toBe("button")
    expect(option.hasAttribute("data-interactive")).toBe(true)
    expect(option.hasAttribute("data-highlighted")).toBe(true)
    await userEvent.click(option)
    expect(onClick).toHaveBeenCalledTimes(1)
  })

  it("keeps the main button and the actions apart", async () => {
    const onOpen = vi.fn()
    const onAction = vi.fn()
    const { container } = render(
      <ListRow
        button={{ className: "own-button", "aria-expanded": false, onClick: onOpen }}
        title="alpha"
        description="说明"
        actions={
          <button type="button" aria-label="新会话" onClick={onAction}>
            +
          </button>
        }
      />,
    )
    const row = container.firstElementChild as HTMLElement
    expect(row.hasAttribute("data-interactive")).toBe(true)
    const main = screen.getByRole("button", { name: /alpha/ })
    expect(main.className).toBe("list-row-button own-button")
    expect(main.getAttribute("type")).toBe("button")
    expect(main.getAttribute("aria-expanded")).toBe("false")
    expect(main.querySelector(".list-row-title")?.textContent).toBe("alpha")
    expect(main.querySelector(".list-row-desc")?.textContent).toBe("说明")

    await userEvent.click(screen.getByRole("button", { name: "新会话" }))
    expect(onAction).toHaveBeenCalledTimes(1)
    expect(onOpen).not.toHaveBeenCalled()

    await userEvent.click(main)
    expect(onOpen).toHaveBeenCalledTimes(1)
  })
})
