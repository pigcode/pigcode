/** 验证浏览器 surface：地址补全、只允许 http/https、工具栏操作、agent 指示与独立窗口打开。 */
// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { BrowserView, normalizeBrowserUrl, type BrowserViewProps } from "./browser-view"

const previewOpen = vi.fn<(url: string) => Promise<{ id: string }>>()

beforeEach(() => {
  previewOpen.mockReset()
  previewOpen.mockResolvedValue({ id: "preview-1" })
  Object.defineProperty(window, "pigcodeNative", {
    configurable: true,
    value: {
      platform: "darwin",
      setThemeSource: vi.fn(),
      windowControl: vi.fn(),
      isMaximized: vi.fn().mockResolvedValue(false),
      previewOpen,
      previewClose: vi.fn(),
    },
  })
})

afterEach(() => {
  cleanup()
  Reflect.deleteProperty(window, "pigcodeNative")
})

const BLANK = { url: "", title: "", loading: false, canGoBack: false, canGoForward: false }

function renderView(overrides: Partial<BrowserViewProps> = {}) {
  const props: BrowserViewProps = {
    page: BLANK,
    onNavigate: vi.fn(),
    onBack: vi.fn(),
    onForward: vi.fn(),
    onReload: vi.fn(),
    slot: <div data-testid="slot" />,
    ...overrides,
  }
  const view = render(<BrowserView {...props} />)
  return { props, ...view }
}

function address(): HTMLInputElement {
  return screen.getByRole("textbox", { name: /输入网址/ }) as HTMLInputElement
}

function visit(value: string): void {
  // userEvent.type 会把 [ 解析成键盘描述符，直接改值更稳妥。
  fireEvent.change(address(), { target: { value } })
  fireEvent.submit(address().closest("form") as HTMLFormElement)
}

describe("normalizeBrowserUrl", () => {
  it("completes ports, local hosts and bare domains", () => {
    expect(normalizeBrowserUrl("3000")).toBe("http://localhost:3000/")
    expect(normalizeBrowserUrl("localhost:5173/app")).toBe("http://localhost:5173/app")
    expect(normalizeBrowserUrl(" https://[::1]:8443 ")).toBe("https://[::1]:8443/")
    expect(normalizeBrowserUrl("127.0.0.1:8080")).toBe("http://127.0.0.1:8080/")
    expect(normalizeBrowserUrl("example.com/docs")).toBe("https://example.com/docs")
    expect(normalizeBrowserUrl("http://example.com")).toBe("http://example.com/")
  })

  it("rejects other protocols and empty input", () => {
    expect(normalizeBrowserUrl("file:///etc/passwd")).toBeNull()
    expect(normalizeBrowserUrl("javascript:alert(1)")).toBeNull()
    expect(normalizeBrowserUrl("pigcode://app/index.html")).toBeNull()
    expect(normalizeBrowserUrl("   ")).toBeNull()
  })
})

describe("BrowserView", () => {
  it("shows the empty state over the page slot until a page is open", () => {
    renderView()
    expect(screen.getByText("还没有打开页面")).toBeTruthy()
    expect(screen.getByTestId("slot")).toBeTruthy()
    expect(screen.getByRole("button", { name: "后退" }).hasAttribute("disabled")).toBe(true)
    expect(screen.getByRole("button", { name: "在新窗口打开" }).hasAttribute("disabled")).toBe(true)
  })

  it("navigates to completed addresses and refuses other protocols", () => {
    const { props } = renderView()
    visit("localhost:3000")
    expect(props.onNavigate).toHaveBeenCalledWith("http://localhost:3000/")
    visit("file:///etc/passwd")
    expect(screen.getByRole("alert").textContent).toBe("只支持 http/https 网址")
    expect(props.onNavigate).toHaveBeenCalledTimes(1)
  })

  it("follows the page state and drives back, forward and reload", async () => {
    const page = {
      url: "http://localhost:3000/",
      title: "Demo",
      loading: true,
      canGoBack: true,
      canGoForward: false,
    }
    const { props, rerender } = renderView({ page })
    expect(address().value).toBe("http://localhost:3000/")
    expect(screen.queryByText("还没有打开页面")).toBeNull()
    expect(document.querySelector(".ic[data-spin]")).not.toBeNull()
    await userEvent.click(screen.getByRole("button", { name: "后退" }))
    expect(props.onBack).toHaveBeenCalled()
    expect(screen.getByRole("button", { name: "前进" }).hasAttribute("disabled")).toBe(true)
    await userEvent.click(screen.getByRole("button", { name: "重新加载" }))
    expect(props.onReload).toHaveBeenCalled()
    // 提交当前地址等于刷新。
    visit("http://localhost:3000/")
    expect(props.onReload).toHaveBeenCalledTimes(2)
    rerender(<BrowserView {...props} page={{ ...page, url: "http://localhost:3000/next" }} />)
    expect(address().value).toBe("http://localhost:3000/next")
  })

  it("shows what the agent is doing", () => {
    renderView({
      page: { ...BLANK, url: "http://localhost:3000/" },
      agent: { action: "click", detail: 'button "登录"' },
    })
    expect(screen.getByRole("status").textContent).toContain('Agent 正在操作点击 · button "登录"')
  })

  it("opens the current page in a separate window", async () => {
    renderView({ page: { ...BLANK, url: "https://example.com/" } })
    await userEvent.click(screen.getByRole("button", { name: "在新窗口打开" }))
    expect(previewOpen).toHaveBeenCalledWith("https://example.com/")
    previewOpen.mockRejectedValueOnce(new Error("PREVIEW_URL_NOT_ALLOWED"))
    await userEvent.click(screen.getByRole("button", { name: "在新窗口打开" }))
    expect((await screen.findByRole("alert")).textContent).toBe("只支持 http/https 网址")
  })
})
