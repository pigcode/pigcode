/** 验证安装对话框：打开时焦点在输入框，安装进行中关闭按钮不可用、对话框不会关掉。 */
// @vitest-environment jsdom
import { cleanup, render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { useState } from "react"
import { afterEach, describe, expect, it, vi } from "vitest"
import { InstallDialog } from "./install-dialog"

afterEach(() => cleanup())

const labels = {
  title: "安装插件",
  description: "从 npm 包、tarball 或本地插件目录安装。",
  spec: "插件目录或 npm 包",
  placeholder: "/path/to/plugin",
  chooseFolder: "选择文件夹…",
  trust: "插件以 Host 权限运行",
  cancel: "取消",
  close: "关闭",
  submit: "安装",
  installing: "正在安装…",
  failed: "安装失败：{reason}",
}

function Harness({ onInstall }: { onInstall: (spec: string) => Promise<void> }) {
  const [open, setOpen] = useState(true)
  return (
    <InstallDialog
      open={open}
      onOpenChange={setOpen}
      onInstall={onInstall}
      labels={labels}
      inputId="install-spec"
    />
  )
}

describe("InstallDialog", () => {
  it("focuses the input, not the close button, when it opens", async () => {
    render(<Harness onInstall={vi.fn(async () => undefined)} />)
    const input = screen.getByLabelText("插件目录或 npm 包")
    await waitFor(() => expect(document.activeElement).toBe(input))
  })

  it("keeps the dialog open while installing", async () => {
    let finish: () => void = () => {}
    const onInstall = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve
        }),
    )
    render(<Harness onInstall={onInstall} />)
    await userEvent.type(screen.getByLabelText("插件目录或 npm 包"), "pigcode-demo")
    await userEvent.click(screen.getByRole("button", { name: "安装" }))

    const close = screen.getByRole("button", { name: "关闭" })
    expect(close.hasAttribute("disabled")).toBe(true)
    await userEvent.keyboard("{Escape}")
    expect(screen.getByRole("dialog", { name: "安装插件" })).toBeTruthy()

    finish()
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull())
  })
})
