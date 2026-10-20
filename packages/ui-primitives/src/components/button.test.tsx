/** 验证 Button 的变体、render 替换与点击。 */
// @vitest-environment jsdom
import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { describe, expect, it, vi } from "vitest"
import { Button } from "./button"

describe("Button", () => {
  it("renders a button with a variant class", () => {
    render(<Button variant="primary">发送</Button>)
    expect(screen.getByRole("button", { name: "发送" }).className).toContain("btn-primary")
  })

  it("supports render replacement", () => {
    render(<Button render={<a href="/settings" />}>设置</Button>)
    expect(screen.getByRole("link", { name: "设置" })).toBeTruthy()
  })

  it("calls onClick", async () => {
    const onClick = vi.fn()
    render(<Button onClick={onClick}>点我</Button>)
    await userEvent.click(screen.getByRole("button", { name: "点我" }))
    expect(onClick).toHaveBeenCalledOnce()
  })
})
