/** 验证创建项目对话框：系统文件夹选择、名称回退与取消。 */
// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { afterEach, describe, expect, it, vi } from "vitest"
import { LocaleProvider } from "@pigcode/ui-primitives"
import { AddProjectDialog } from "./add-project-dialog"

function mockPicker(result: string | null) {
  const pickFolder = vi.fn().mockResolvedValue(result)
  Object.defineProperty(window, "pigcodeNative", {
    configurable: true,
    value: { platform: "linux", pickFolder },
  })
  return pickFolder
}

function renderDialog(onAdd = vi.fn(), onOpenChange = vi.fn()) {
  render(
    <LocaleProvider locale="zh-CN">
      <AddProjectDialog open onOpenChange={onOpenChange} onAdd={onAdd} />
    </LocaleProvider>,
  )
  return { onAdd, onOpenChange }
}

afterEach(() => {
  cleanup()
  Reflect.deleteProperty(window, "pigcodeNative")
})

describe("AddProjectDialog", () => {
  it("shows name, device and source folder", () => {
    mockPicker(null)
    renderDialog()

    expect(screen.getByRole("heading", { name: "创建项目" })).toBeTruthy()
    expect(screen.getByLabelText("项目名称").getAttribute("placeholder")).toBe("新项目")
    expect(screen.getByRole("combobox", { name: "设备" }).textContent).toContain("此电脑")
    expect(screen.getByRole("button", { name: "选择文件夹" })).toBeTruthy()
    expect(screen.getByRole("button", { name: "创建项目" }).hasAttribute("disabled")).toBe(false)
  })

  it("picks the folder with the system dialog and falls back to the folder name", async () => {
    const pickFolder = mockPicker("/home/me/work/pigcode")
    const { onAdd, onOpenChange } = renderDialog()

    await userEvent.click(screen.getByRole("button", { name: "选择文件夹" }))
    expect(pickFolder).toHaveBeenCalledWith({ title: "选择项目文件夹", buttonLabel: "选择" })
    expect(await screen.findByText("/home/me/work/pigcode")).toBeTruthy()
    expect(screen.getByRole("button", { name: "更换文件夹 /home/me/work/pigcode" })).toBeTruthy()
    expect(screen.getByLabelText("项目名称").getAttribute("placeholder")).toBe("pigcode")

    await userEvent.click(screen.getByRole("button", { name: "创建项目" }))
    expect(onAdd).toHaveBeenCalledWith("/home/me/work/pigcode", undefined)
    expect(onOpenChange).toHaveBeenCalledWith(false)
  })

  it("passes a typed project name", async () => {
    mockPicker("/home/me/work/pigcode")
    const { onAdd } = renderDialog()

    await userEvent.type(screen.getByLabelText("项目名称"), "  客户门户 ")
    await userEvent.click(screen.getByRole("button", { name: "选择文件夹" }))
    await screen.findByText("/home/me/work/pigcode")
    await userEvent.click(screen.getByRole("button", { name: "创建项目" }))
    expect(onAdd).toHaveBeenCalledWith("/home/me/work/pigcode", "客户门户")
  })

  it("asks for the folder when creating without one, then creates with it", async () => {
    const pickFolder = mockPicker("/home/me/work/pigcode")
    const { onAdd } = renderDialog()

    await userEvent.type(screen.getByLabelText("项目名称"), "门户")
    await userEvent.click(screen.getByRole("button", { name: "创建项目" }))
    expect(pickFolder).toHaveBeenCalledTimes(1)
    expect(onAdd).toHaveBeenCalledWith("/home/me/work/pigcode", "门户")
  })

  it("creates nothing when the system dialog is cancelled", async () => {
    const pickFolder = mockPicker(null)
    const { onAdd, onOpenChange } = renderDialog()

    await userEvent.click(screen.getByRole("button", { name: "选择文件夹" }))
    await userEvent.click(screen.getByRole("button", { name: "创建项目" }))
    expect(pickFolder).toHaveBeenCalledTimes(2)
    expect(screen.getByText("Pigcode 可读取和编辑这个文件夹")).toBeTruthy()
    expect(onAdd).not.toHaveBeenCalled()
    expect(onOpenChange).not.toHaveBeenCalled()
  })

  it("disables folder selection and creation without the native bridge", () => {
    renderDialog()
    expect(screen.getByRole("button", { name: "选择文件夹" }).hasAttribute("disabled")).toBe(true)
    expect(screen.getByRole("button", { name: "创建项目" }).hasAttribute("disabled")).toBe(true)
  })
})
