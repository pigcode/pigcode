/** 验证状态点：色调写在 data-tone 上，运行中换成点阵，有 label 时读屏可读。 */
// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react"
import { afterEach, describe, expect, it } from "vitest"
import { StatusDot } from "./status-dot"

afterEach(() => cleanup())

describe("StatusDot", () => {
  it("renders a plain dot with the tone", () => {
    const { container } = render(
      <StatusDot tone="error" className="sess-dot" data-status="failed" />,
    )
    const dot = container.firstElementChild as HTMLElement
    expect(dot.className).toBe("status-dot sess-dot")
    expect(dot.dataset.tone).toBe("error")
    expect(dot.dataset.status).toBe("failed")
    expect(dot.getAttribute("aria-hidden")).toBe("true")
    expect(dot.querySelector(".dot-matrix")).toBeNull()
  })

  it("shows the dot matrix while running", () => {
    const { container } = render(<StatusDot tone="running" />)
    expect(container.querySelector(".status-dot .dot-matrix")).not.toBeNull()
  })

  it("is announced when it has a label", () => {
    render(<StatusDot tone="warning" label="等待许可" />)
    expect(screen.getByRole("img", { name: "等待许可" }).dataset.tone).toBe("warning")
  })
})
