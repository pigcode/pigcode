/** 验证空状态的各部分顺序与类名、尺寸的数据属性，以及外层 div 的属性透传。 */
// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react"
import { afterEach, describe, expect, it } from "vitest"
import { EmptyState } from "./empty-state"

afterEach(() => cleanup())

describe("EmptyState", () => {
  it("renders the slots in order with their classes", () => {
    const { container } = render(
      <EmptyState
        className="extra"
        icon={<svg data-testid="icon" />}
        title="没有改动"
        description="修改文件后，这里会显示差异。"
        actions={<button type="button">刷新</button>}
      />,
    )
    const root = container.firstElementChild as HTMLElement
    expect(root.tagName).toBe("DIV")
    expect(root.className).toBe("empty-state extra")
    expect(root.hasAttribute("data-size")).toBe(false)
    expect(Array.from(root.children).map((child) => child.className)).toEqual([
      "empty-state-icon",
      "empty-state-title",
      "empty-state-desc",
      "empty-state-actions",
    ])
    expect(screen.getByTestId("icon").parentElement?.getAttribute("aria-hidden")).toBe("true")
    expect(screen.getByText("没有改动").tagName).toBe("P")
    expect(screen.getByText("修改文件后，这里会显示差异。").tagName).toBe("P")
    expect(screen.getByRole("button", { name: "刷新" }).parentElement?.className).toBe(
      "empty-state-actions",
    )
  })

  it("leaves out the optional slots", () => {
    const { container } = render(<EmptyState title="没有匹配的结果" />)
    const root = container.firstElementChild as HTMLElement
    expect(Array.from(root.children).map((child) => child.className)).toEqual(["empty-state-title"])
  })

  it("marks the compact size and passes div props through", () => {
    const { container } = render(
      <EmptyState size="compact" title="正在读取…" role="status" aria-live="polite" data-x="1" />,
    )
    const root = container.firstElementChild as HTMLElement
    expect(root.getAttribute("data-size")).toBe("compact")
    expect(screen.getByRole("status").textContent).toBe("正在读取…")
    expect(root.getAttribute("aria-live")).toBe("polite")
    expect(root.getAttribute("data-x")).toBe("1")
  })
})
