/** 验证 Base UI Dialog 的打开与关闭。 */
// @vitest-environment jsdom
import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { describe, expect, it } from "vitest"
import { Dialog } from "./dialog"
import { Button } from "./button"

describe("Dialog", () => {
  it("opens and closes", async () => {
    render(
      <Dialog.Root>
        <Dialog.Trigger render={<Button>打开</Button>} />
        <Dialog.Portal>
          <Dialog.Backdrop />
          <Dialog.Popup>
            <Dialog.Title>标题</Dialog.Title>
            <Dialog.Close render={<Button>关闭</Button>} />
          </Dialog.Popup>
        </Dialog.Portal>
      </Dialog.Root>,
    )
    await userEvent.click(screen.getByRole("button", { name: "打开" }))
    expect(screen.getByText("标题")).toBeTruthy()
    await userEvent.click(screen.getByRole("button", { name: "关闭" }))
    expect(screen.queryByText("标题")).toBeNull()
  })
})
