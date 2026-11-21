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

  it("adds the pill shape on top of the size", () => {
    render(
      <Button size="lg" shape="pill">
        插件管理
      </Button>,
    )
    const button = screen.getByRole("button", { name: "插件管理" })
    expect(button.className).toContain("btn-lg")
    expect(button.className).toContain("btn-pill")
    render(<Button>默认</Button>)
    expect(screen.getByRole("button", { name: "默认" }).className).not.toContain("btn-pill")
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
