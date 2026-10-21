/** 验证预览面板：默认地址、合法 URL 调用 previewOpen、错误展示。 */
// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { PreviewPanel } from "./preview-panel"

const previewOpen = vi.fn<(url: string) => Promise<{ id: string }>>()
const previewClose = vi.fn()

beforeEach(() => {
  previewOpen.mockReset()
  previewOpen.mockResolvedValue({ id: "preview-1" })
  previewClose.mockReset()
  Object.defineProperty(window, "pigcodeNative", {
    configurable: true,
    value: {
      platform: "darwin",
      setThemeSource: vi.fn(),
      windowControl: vi.fn(),
      isMaximized: vi.fn().mockResolvedValue(false),
      previewOpen,
      previewClose,
    },
  })
})

afterEach(() => {
  cleanup()
  Reflect.deleteProperty(window, "pigcodeNative")
})

describe("PreviewPanel", () => {
  it("opens the default localhost url through the native bridge", async () => {
    render(<PreviewPanel />)

    const input = screen.getByLabelText("本地地址") as HTMLInputElement
    expect(input.value).toBe("http://localhost:3000")

    await userEvent.click(screen.getByRole("button", { name: "打开预览" }))

    expect(previewOpen).toHaveBeenCalledWith("http://localhost:3000")
  })

  it("opens a typed loopback url", async () => {
    render(<PreviewPanel />)

    const input = screen.getByLabelText("本地地址")
    // userEvent.type 会把 [ 解析成键盘描述符，IPv6 地址直接改值更稳妥。
    fireEvent.change(input, { target: { value: "https://[::1]:8443" } })
    await userEvent.click(screen.getByRole("button", { name: "打开预览" }))

    expect(previewOpen).toHaveBeenCalledWith("https://[::1]:8443")
  })

  it("shows an error when the host rejects a non-loopback url", async () => {
    previewOpen.mockRejectedValue(new Error("PREVIEW_URL_NOT_ALLOWED"))
    render(<PreviewPanel />)

    const input = screen.getByLabelText("本地地址")
    await userEvent.clear(input)
    await userEvent.type(input, "https://example.com")
    await userEvent.click(screen.getByRole("button", { name: "打开预览" }))

    expect((await screen.findByRole("alert")).textContent).toMatch(/仅支持本地/)
  })

  it("shows a friendly error when the bridge is unavailable", async () => {
    Reflect.deleteProperty(window, "pigcodeNative")
    render(<PreviewPanel />)

    await userEvent.click(screen.getByRole("button", { name: "打开预览" }))

    expect((await screen.findByRole("alert")).textContent).toMatch(/不支持预览窗口/)
  })

  it("does not open an empty url", async () => {
    render(<PreviewPanel />)

    await userEvent.clear(screen.getByLabelText("本地地址"))
    await userEvent.click(screen.getByRole("button", { name: "打开预览" }))

    expect(previewOpen).not.toHaveBeenCalled()
  })
})
