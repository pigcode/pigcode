/** 验证对话框的统一结构：标题、说明、关闭按钮、Esc 与底部按钮。 */
// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { afterEach, describe, expect, it } from "vitest"
import { Button } from "./button"
import { Dialog } from "./dialog"

afterEach(() => cleanup())

function Example() {
  return (
    <Dialog.Root>
      <Dialog.Trigger render={<Button>打开</Button>} />
      <Dialog.Content title="标题" description="一行说明" closeLabel="关闭">
        <Dialog.Body>正文</Dialog.Body>
        <Dialog.Footer>
          <Dialog.Close render={<Button variant="ghost">取消</Button>} />
          <Button variant="primary">确定</Button>
        </Dialog.Footer>
      </Dialog.Content>
    </Dialog.Root>
  )
}

describe("Dialog", () => {
  it("names the dialog by its title and describes it", async () => {
    render(<Example />)
    await userEvent.click(screen.getByRole("button", { name: "打开" }))
    const dialog = screen.getByRole("dialog", { name: "标题" })
    expect(dialog.classList.contains("dialog")).toBe(true)
    expect(screen.getByRole("heading", { name: "标题" })).toBeTruthy()
    expect(dialog.getAttribute("aria-describedby")).toBe(screen.getByText("一行说明").id)
    expect(screen.getByText("正文").classList.contains("dialog-body")).toBe(true)
    const buttons = screen.getByText("确定").parentElement
    expect(buttons?.classList.contains("dialog-foot")).toBe(true)
  })

  it("closes from the close button, the cancel button and Esc", async () => {
    render(<Example />)
    const open = screen.getByRole("button", { name: "打开" })

    await userEvent.click(open)
    await userEvent.click(screen.getByRole("button", { name: "关闭" }))
    expect(screen.queryByRole("dialog")).toBeNull()

    await userEvent.click(open)
    await userEvent.click(screen.getByRole("button", { name: "取消" }))
    expect(screen.queryByRole("dialog")).toBeNull()

    await userEvent.click(open)
    await userEvent.keyboard("{Escape}")
    expect(screen.queryByRole("dialog")).toBeNull()
  })
})
