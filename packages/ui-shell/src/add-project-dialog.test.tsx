/** 验证创建项目对话框：系统文件夹选择、名称回退与取消。 */
// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { afterEach, describe, expect, it, vi } from "vitest"
import type { HostBrowseDirsResult, HostSummary } from "@pigcode/contracts"
import { LocaleProvider } from "@pigcode/ui-primitives"
import { AddProjectDialog } from "./add-project-dialog"

function makeHost(
  partial: Pick<HostSummary, "id" | "name" | "kind" | "badgeColor" | "channel">,
): HostSummary {
  return {
    ...partial,
    hostKey: null,
    status: "connected",
    latencyMs: null,
    lanAddresses: [],
    relayAddress: null,
    lastConnectedAt: null,
    lastError: null,
  }
}

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
  it("offers the local folder and project name directly", () => {
    mockPicker(null)
    renderDialog()

    expect(screen.getByRole("heading", { name: "添加项目" })).toBeTruthy()
    expect(screen.getByLabelText("名字").getAttribute("placeholder")).toBe("新项目")
    expect(screen.queryByRole("combobox")).toBeNull()
    expect(screen.getByRole("button", { name: "选择文件夹" })).toBeTruthy()
    expect(screen.getByRole("button", { name: "添加" }).hasAttribute("disabled")).toBe(false)
  })

  it("picks the folder with the system dialog and falls back to the folder name", async () => {
    const pickFolder = mockPicker("/home/me/work/pigcode")
    const { onAdd, onOpenChange } = renderDialog()

    await userEvent.click(screen.getByRole("button", { name: "选择文件夹" }))
    expect(pickFolder).toHaveBeenCalledWith({ title: "选择项目文件夹", buttonLabel: "选择" })
    expect(await screen.findByText("/home/me/work/pigcode")).toBeTruthy()
    expect(screen.getByRole("button", { name: "换文件夹 /home/me/work/pigcode" })).toBeTruthy()
    expect(screen.getByLabelText("名字").getAttribute("placeholder")).toBe("pigcode")

    await userEvent.click(screen.getByRole("button", { name: "添加" }))
    expect(onAdd).toHaveBeenCalledWith("/home/me/work/pigcode", undefined)
    expect(onOpenChange).toHaveBeenCalledWith(false)
  })

  it("passes a typed project name", async () => {
    mockPicker("/home/me/work/pigcode")
    const { onAdd } = renderDialog()

    await userEvent.type(screen.getByLabelText("名字"), "  客户门户 ")
    await userEvent.click(screen.getByRole("button", { name: "选择文件夹" }))
    await screen.findByText("/home/me/work/pigcode")
    await userEvent.click(screen.getByRole("button", { name: "添加" }))
    expect(onAdd).toHaveBeenCalledWith("/home/me/work/pigcode", "客户门户")
  })

  it("asks for the folder when creating without one, then creates with it", async () => {
    const pickFolder = mockPicker("/home/me/work/pigcode")
    const { onAdd } = renderDialog()

    await userEvent.type(screen.getByLabelText("名字"), "门户")
    await userEvent.click(screen.getByRole("button", { name: "添加" }))
    expect(pickFolder).toHaveBeenCalledTimes(1)
    expect(onAdd).toHaveBeenCalledWith("/home/me/work/pigcode", "门户")
  })

  it("creates nothing when the system dialog is cancelled", async () => {
    const pickFolder = mockPicker(null)
    const { onAdd, onOpenChange } = renderDialog()

    await userEvent.click(screen.getByRole("button", { name: "选择文件夹" }))
    await userEvent.click(screen.getByRole("button", { name: "添加" }))
    expect(pickFolder).toHaveBeenCalledTimes(2)
    expect(screen.getByText("Agent 会在这个文件夹里读写文件")).toBeTruthy()
    expect(onAdd).not.toHaveBeenCalled()
    expect(onOpenChange).not.toHaveBeenCalled()
  })

  it("disables folder selection and creation without the native bridge", () => {
    renderDialog()
    expect(screen.getByRole("button", { name: "选择文件夹" }).hasAttribute("disabled")).toBe(true)
    expect(screen.getByRole("button", { name: "添加" }).hasAttribute("disabled")).toBe(true)
  })

  it("keeps typed remote path when initial browseDirs finishes afterward", async () => {
    let resolveInitial!: (value: HostBrowseDirsResult) => void
    const browseRemoteDirs = vi.fn().mockImplementation(
      () =>
        new Promise<HostBrowseDirsResult>((resolve) => {
          resolveInitial = resolve
        }),
    )
    render(
      <LocaleProvider locale="zh-CN">
        <AddProjectDialog
          open
          onOpenChange={vi.fn()}
          onAdd={vi.fn()}
          hosts={[
            makeHost({
              id: "local",
              name: "本机",
              kind: "local",
              badgeColor: "slate",
              channel: "local",
            }),
            makeHost({
              id: "remote-1",
              name: "Studio Linux",
              kind: "headless",
              badgeColor: "amber",
              channel: "lan",
            }),
          ]}
          targetHostId="remote-1"
          browseRemoteDirs={browseRemoteDirs}
        />
      </LocaleProvider>,
    )

    const input = screen.getByPlaceholderText("/path/to/project") as HTMLInputElement
    await userEvent.type(input, "/srv/app")
    resolveInitial({
      path: "/home/dev",
      homePath: "/home/dev",
      parentPath: "/home",
      entries: [],
    })
    await screen.findByText("此目录下没有子文件夹")
    expect(input.value).toBe("/srv/app")
  })
})
