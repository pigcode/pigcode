/** 验证线程头的「用…打开」分段按钮：应用图标、记住上次选的应用、失败提示与复制路径。 */
// @vitest-environment jsdom
import { cleanup, render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { LocaleProvider } from "@pigcode/ui-primitives"
import { OpenInButton } from "./open-in"
import { ToastProvider } from "./toast"

const APPS = [
  {
    id: "finder",
    name: "Finder",
    kind: "file-manager" as const,
    icon: "data:image/png;base64,AAAA",
  },
  { id: "cursor", name: "Cursor", kind: "editor" as const, icon: "data:image/png;base64,BBBB" },
  { id: "ghostty", name: "Ghostty", kind: "terminal" as const, icon: null },
]

/** 用替身代替 preload 暴露的原生桥。 */
function mockNative(value: Partial<NonNullable<Window["pigcodeNative"]>>): void {
  Object.defineProperty(window, "pigcodeNative", { configurable: true, value })
}

function renderButton(path: string) {
  render(
    <LocaleProvider locale="zh-CN">
      <ToastProvider>
        <OpenInButton path={path} />
      </ToastProvider>
    </LocaleProvider>,
  )
}

beforeEach(() => window.localStorage.clear())

afterEach(() => {
  cleanup()
  Reflect.deleteProperty(window, "pigcodeNative")
  Reflect.deleteProperty(navigator, "clipboard")
})

describe("OpenInButton", () => {
  it("opens with the file manager first, then remembers the app picked from the list", async () => {
    const listOpenApps = vi.fn().mockResolvedValue(APPS)
    const openWithApp = vi.fn().mockResolvedValue(undefined)
    mockNative({ platform: "darwin", listOpenApps, openWithApp })
    renderButton("/Users/me/app")

    const main = await screen.findByRole("button", { name: "在 Finder 中打开" })
    expect(main.querySelector("img")?.getAttribute("src")).toBe(APPS[0]?.icon)
    await userEvent.click(main)
    expect(openWithApp).toHaveBeenLastCalledWith("finder", "/Users/me/app")

    await userEvent.click(screen.getByRole("button", { name: "选择打开方式" }))
    const items = await screen.findAllByRole("menuitem")
    expect(items.map((item) => item.querySelector(".grow")?.textContent)).toEqual([
      "Finder",
      "Cursor",
      "Ghostty",
      "复制路径",
    ])
    expect(screen.getByRole("menuitem", { name: "Ghostty" })).toBeTruthy()
    // 没有图标的应用显示首字母。
    expect(items[2]?.querySelector(".app-icon.is-letter")?.textContent).toBe("G")
    await userEvent.click(screen.getByRole("menuitem", { name: "Cursor" }))
    expect(openWithApp).toHaveBeenLastCalledWith("cursor", "/Users/me/app")
    expect(window.localStorage.getItem("pigcode.openInApp")).toBe("cursor")
    expect(await screen.findByRole("button", { name: "在 Cursor 中打开" })).toBeTruthy()
    // 挂载时取一次，每次打开菜单再刷新。
    expect(listOpenApps).toHaveBeenCalledTimes(2)
  })

  it("names the Windows file manager in the current language and copies the path", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined)
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } })
    mockNative({
      platform: "win32",
      listOpenApps: vi
        .fn()
        .mockResolvedValue([
          { id: "explorer", name: "File Explorer", kind: "file-manager", icon: null },
        ]),
    })
    renderButton("C:\\work\\app")

    expect(await screen.findByRole("button", { name: "在 资源管理器 中打开" })).toBeTruthy()
    await userEvent.click(screen.getByRole("button", { name: "选择打开方式" }))
    await userEvent.click(await screen.findByRole("menuitem", { name: "复制路径" }))
    expect(writeText).toHaveBeenCalledExactlyOnceWith("C:\\work\\app")
    expect(await screen.findByText("已复制路径")).toBeTruthy()
  })

  it("reports a folder that can't be opened", async () => {
    mockNative({
      platform: "linux",
      listOpenApps: vi.fn().mockResolvedValue([APPS[1]]),
      openWithApp: vi.fn().mockRejectedValue(new Error("FOLDER_NOT_FOUND")),
    })
    renderButton("/home/me/gone")

    await userEvent.click(await screen.findByRole("button", { name: "在 Cursor 中打开" }))
    expect(await screen.findByText("无法打开文件夹 /home/me/gone")).toBeTruthy()
  })

  it("renders nothing without the native bridge", async () => {
    renderButton("/home/me/app")
    await waitFor(() => expect(screen.queryByRole("group")).toBeNull())
  })
})
