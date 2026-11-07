/**
 * 验证浏览器 surface：地址补全与连接类型、工具栏（停止、更多菜单）、响应式视图与设备栏、选择网页元素的开关、
 * 页面区的空白 / 加载失败 / 崩溃状态。agent 指示与短提示浮在 webview 上，由桌面端的宿主负责。
 */
// @vitest-environment jsdom
import { cleanup, fireEvent, render as renderUi, screen, within } from "@testing-library/react"
import type { ReactElement } from "react"
import userEvent from "@testing-library/user-event"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { LocaleProvider } from "@pigcode/ui-primitives"
import { connectionOf, isLocalBrowserUrl, normalizeBrowserUrl } from "./browser-url"
import { BrowserView, type BrowserViewProps } from "./browser-view"
import { DEFAULT_VIEWPORT, fitViewport } from "./browser-viewport"

/** 组件文案来自 locale；测试按中文界面渲染。 */
function render(ui: ReactElement) {
  return renderUi(ui, {
    wrapper: ({ children }) => <LocaleProvider locale="zh-CN">{children}</LocaleProvider>,
  })
}

const previewOpen = vi.fn<(url: string) => Promise<{ id: string }>>()

beforeEach(() => {
  previewOpen.mockReset()
  previewOpen.mockResolvedValue({ id: "preview-1" })
  Object.defineProperty(window, "pigcodeNative", {
    configurable: true,
    value: { platform: "darwin", previewOpen, previewClose: vi.fn() },
  })
})

afterEach(() => {
  cleanup()
  Reflect.deleteProperty(window, "pigcodeNative")
})

const BLANK = { url: "", title: "", loading: false, canGoBack: false, canGoForward: false }
const LOCAL = { ...BLANK, url: "http://localhost:3000/" }

function renderView(overrides: Partial<BrowserViewProps> = {}) {
  const props: BrowserViewProps = {
    page: BLANK,
    onNavigate: vi.fn(),
    onBack: vi.fn(),
    onForward: vi.fn(),
    onReload: vi.fn(),
    onStop: vi.fn(),
    onViewportChange: vi.fn(),
    onTogglePicker: vi.fn(),
    onOpenDevTools: vi.fn(),
    onOpenDefault: vi.fn(),
    onCopyUrl: vi.fn(),
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

async function openMore(): Promise<void> {
  await userEvent.click(screen.getByRole("button", { name: "更多" }))
}

describe("browser addresses", () => {
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

  it("tells local, secure and unencrypted connections apart", () => {
    expect(connectionOf("http://localhost:3000/")).toBe("local")
    expect(connectionOf("https://example.com/")).toBe("secure")
    expect(connectionOf("http://example.com/")).toBe("insecure")
    expect(connectionOf("about:blank")).toBeNull()
    expect(isLocalBrowserUrl("http://127.0.0.1:8080/")).toBe(true)
    expect(isLocalBrowserUrl("https://example.com/")).toBe(false)
  })
})

describe("fitViewport", () => {
  it("centres a device that fits and shrinks one that doesn't, keeping its proportions", () => {
    expect(fitViewport({ width: 800, height: 1000 }, { width: 393, height: 852 })).toEqual({
      x: 204,
      y: 74,
      width: 393,
      height: 852,
      scale: 1,
    })
    // 上下各留 16 的边：852 × 0.5 + 32 = 458。
    const shrunk = fitViewport({ width: 600, height: 458 }, { width: 393, height: 852 })
    expect(shrunk.scale).toBeCloseTo(0.5)
    expect(shrunk.height).toBe(426)
    expect(shrunk.x).toBe(Math.round((600 - shrunk.width) / 2))
  })
})

describe("BrowserView", () => {
  it("shows the empty state over the page slot until a page is open", () => {
    renderView()
    expect(screen.getByRole("heading", { name: "浏览器" })).toBeTruthy()
    expect(screen.getByTestId("slot")).toBeTruthy()
    expect(screen.getByRole("button", { name: "后退" }).hasAttribute("disabled")).toBe(true)
    expect(screen.getByRole("button", { name: "重新加载" }).hasAttribute("disabled")).toBe(true)
    expect(
      screen.getByRole("button", { name: "选择网页元素加入聊天" }).hasAttribute("disabled"),
    ).toBe(true)
  })

  it("navigates to completed addresses and refuses other protocols", () => {
    const { props } = renderView()
    visit("localhost:3000")
    expect(props.onNavigate).toHaveBeenCalledWith("http://localhost:3000/")
    visit("file:///etc/passwd")
    expect(screen.getByRole("alert").textContent).toBe("只支持 http/https 网址")
    expect(props.onNavigate).toHaveBeenCalledTimes(1)
  })

  it("follows the page state, stops a load and drives back, forward and reload", async () => {
    const page = { ...LOCAL, title: "Demo", loading: true, canGoBack: true }
    const { props, rerender } = renderView({ page })
    expect(address().value).toBe("http://localhost:3000/")
    expect(screen.queryByRole("heading", { name: "浏览器" })).toBeNull()
    expect(screen.getByRole("progressbar", { name: "正在加载" })).toBeTruthy()
    await userEvent.click(screen.getByRole("button", { name: "停止加载" }))
    expect(props.onStop).toHaveBeenCalled()
    await userEvent.click(screen.getByRole("button", { name: "后退" }))
    expect(props.onBack).toHaveBeenCalled()
    expect(screen.getByRole("button", { name: "前进" }).hasAttribute("disabled")).toBe(true)

    rerender(<BrowserView {...props} page={{ ...page, loading: false }} />)
    expect(screen.queryByRole("progressbar")).toBeNull()
    await userEvent.click(screen.getByRole("button", { name: "重新加载" }))
    expect(props.onReload).toHaveBeenCalledTimes(1)
    // 提交当前地址等于刷新。
    visit("http://localhost:3000/")
    expect(props.onReload).toHaveBeenCalledTimes(2)
    rerender(<BrowserView {...props} page={{ ...page, url: "http://localhost:3000/next" }} />)
    expect(address().value).toBe("http://localhost:3000/next")
  })

  it("marks secure connections and shows the site icon in the address bar", () => {
    const { rerender, props } = renderView({ page: { ...BLANK, url: "https://example.com/" } })
    expect(screen.getByText("安全连接（HTTPS）")).toBeTruthy()
    rerender(
      <BrowserView
        {...props}
        page={{ ...BLANK, url: "https://example.com/", favicon: "https://example.com/icon.png" }}
      />,
    )
    expect(document.querySelector(".browser-site img")?.getAttribute("src")).toBe(
      "https://example.com/icon.png",
    )
  })

  it("opens the page in the default browser, a new window, copies it and opens devtools", async () => {
    const { props } = renderView({ page: LOCAL })
    await openMore()
    await userEvent.click(await screen.findByRole("menuitem", { name: "在默认浏览器中打开" }))
    expect(props.onOpenDefault).toHaveBeenCalledWith("http://localhost:3000/")

    await openMore()
    await userEvent.click(await screen.findByRole("menuitem", { name: "在新窗口打开" }))
    expect(previewOpen).toHaveBeenCalledWith("http://localhost:3000/")

    await openMore()
    await userEvent.click(await screen.findByRole("menuitem", { name: "复制网址" }))
    expect(props.onCopyUrl).toHaveBeenCalledWith("http://localhost:3000/")

    await openMore()
    await userEvent.click(await screen.findByRole("menuitem", { name: "开发者工具" }))
    expect(props.onOpenDevTools).toHaveBeenCalled()
  })

  it("only offers a separate window for local addresses", async () => {
    renderView({ page: { ...BLANK, url: "https://example.com/" } })
    await openMore()
    const item = await screen.findByRole("menuitem", { name: "在新窗口打开" })
    expect(item.getAttribute("aria-disabled")).toBe("true")
  })

  it("explains preview window failures", async () => {
    renderView({ page: LOCAL })
    previewOpen.mockRejectedValueOnce(new Error("PREVIEW_BRIDGE_UNAVAILABLE"))
    await openMore()
    await userEvent.click(await screen.findByRole("menuitem", { name: "在新窗口打开" }))
    expect((await screen.findByRole("alert")).textContent).toBe("当前环境不支持预览窗口")
  })

  it("turns on the responsive view and edits the device, size and orientation", async () => {
    const { props, rerender } = renderView({ page: LOCAL })
    await userEvent.click(screen.getByRole("button", { name: "响应式视图" }))
    expect(props.onViewportChange).toHaveBeenCalledWith(DEFAULT_VIEWPORT)

    rerender(<BrowserView {...props} viewport={DEFAULT_VIEWPORT} viewportScale={0.5} />)
    expect(
      screen.getByRole("button", { name: "退出响应式视图" }).getAttribute("aria-pressed"),
    ).toBe("true")
    expect(screen.getByText("缩放 50%")).toBeTruthy()
    await userEvent.click(screen.getByRole("combobox", { name: "设备" }))
    await userEvent.click(await screen.findByRole("option", { name: /iPad mini/ }))
    expect(props.onViewportChange).toHaveBeenLastCalledWith({
      device: "ipad-mini",
      width: 768,
      height: 1024,
    })

    const width = screen.getByRole("spinbutton", { name: "视口宽度" })
    fireEvent.change(width, { target: { value: "500" } })
    fireEvent.blur(width)
    expect(props.onViewportChange).toHaveBeenLastCalledWith({
      device: "custom",
      width: 500,
      height: 852,
    })
    await userEvent.click(screen.getByRole("button", { name: "横竖切换" }))
    expect(props.onViewportChange).toHaveBeenLastCalledWith({
      device: "iphone-15-pro",
      width: 852,
      height: 393,
    })
    await userEvent.click(screen.getByRole("button", { name: "退出响应式视图" }))
    expect(props.onViewportChange).toHaveBeenLastCalledWith(null)
  })

  it("toggles element picking from the toolbar", async () => {
    const { props, rerender } = renderView({ page: LOCAL })
    await userEvent.click(screen.getByRole("button", { name: "选择网页元素加入聊天" }))
    expect(props.onTogglePicker).toHaveBeenCalledTimes(1)
    rerender(<BrowserView {...props} picking />)
    const cancel = screen.getByRole("button", { name: "取消选择元素" })
    expect(cancel.getAttribute("aria-pressed")).toBe("true")
    await userEvent.click(cancel)
    expect(props.onTogglePicker).toHaveBeenCalledTimes(2)
  })

  it("explains certificate failures and reloads on retry", async () => {
    const { props } = renderView({
      page: {
        ...BLANK,
        url: "https://self-signed.test/",
        error: {
          code: -202,
          description: "ERR_CERT_AUTHORITY_INVALID",
          url: "https://self-signed.test/",
        },
      },
    })
    const alert = screen.getByRole("alert")
    expect(alert.textContent).toContain("这个网站的安全证书有问题")
    expect(alert.textContent).toContain("ERR_CERT_AUTHORITY_INVALID")
    expect(alert.textContent).toContain("本机的开发服务器可以改用 http")
    await userEvent.click(within(alert).getByRole("button", { name: "重新加载" }))
    expect(props.onReload).toHaveBeenCalled()
  })

  it("shows a plain load failure and a crashed page", () => {
    const { props, rerender } = renderView({
      page: {
        ...LOCAL,
        error: { code: -102, description: "ERR_CONNECTION_REFUSED", url: "http://localhost:3000/" },
      },
    })
    expect(screen.getByRole("alert").textContent).toContain("无法打开这个网页")
    rerender(<BrowserView {...props} page={{ ...LOCAL, crashed: { reason: "oom" } }} />)
    expect(screen.getByRole("alert").textContent).toContain("页面意外退出了")
    expect(screen.getByRole("alert").textContent).toContain("oom")
  })
})
