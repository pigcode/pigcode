/** 验证预览窗口只接受 loopback http/https，并在沙箱窗口中加载。 */
import { beforeEach, describe, expect, it, vi } from "vitest"

/** 用最小 BrowserWindow 替身捕获构造参数、加载 URL 与关闭动作。 */
const { FakeBrowserWindow } = vi.hoisted(() => {
  interface FakeNavigationEvent {
    preventDefault(): void
  }

  class FakeSession {
    permissionHandler: ((callback: (allowed: boolean) => void) => void) | null = null

    setPermissionRequestHandler(
      handler: (
        _contents: unknown,
        _permission: unknown,
        callback: (allowed: boolean) => void,
      ) => void,
    ): this {
      this.permissionHandler = (callback) => handler(undefined, undefined, callback)
      return this
    }
  }

  class FakeWebContents {
    private readonly listeners = new Map<string, (...args: unknown[]) => void>()
    openHandler: ((details: { url: string }) => { action: "allow" | "deny" }) | null = null
    readonly session = new FakeSession()

    on(event: string, listener: (...args: unknown[]) => void): this {
      this.listeners.set(event, listener)
      return this
    }

    setWindowOpenHandler(
      handler: (details: { url: string }) => { action: "allow" | "deny" },
    ): this {
      this.openHandler = handler
      return this
    }

    emitNavigation(event: string, url: string): boolean {
      let prevented = false
      const listener = this.listeners.get(event) as
        ((event: FakeNavigationEvent, url: string) => void) | undefined
      listener?.({ preventDefault: () => (prevented = true) }, url)
      return prevented
    }

    emitFrameNavigation(url: string, isMainFrame: boolean): boolean {
      let prevented = false
      const listener = this.listeners.get("will-frame-navigate") as
        ((event: FakeNavigationEvent & { url: string; isMainFrame: boolean }) => void) | undefined
      listener?.({ preventDefault: () => (prevented = true), url, isMainFrame })
      return prevented
    }

    emitDidCreateWindow(window: FakeBrowserWindow): void {
      const listener = this.listeners.get("did-create-window") as
        ((window: FakeBrowserWindow) => void) | undefined
      listener?.(window)
    }
  }

  class FakeBrowserWindow {
    static instances: FakeBrowserWindow[] = []

    readonly options: unknown
    readonly webContents = new FakeWebContents()
    url: string | null = null
    closed = false
    private readonly listeners = new Map<string, () => void>()

    constructor(options: unknown) {
      this.options = options
      FakeBrowserWindow.instances.push(this)
    }

    loadURL(url: string): Promise<void> {
      this.url = url
      return Promise.resolve()
    }

    on(event: string, listener: () => void): this {
      this.listeners.set(event, listener)
      return this
    }

    close(): void {
      this.closed = true
      this.listeners.get("closed")?.()
    }

    isDestroyed(): boolean {
      return this.closed
    }
  }
  return { FakeBrowserWindow }
})

vi.mock("electron", () => ({ BrowserWindow: FakeBrowserWindow }))

const { closePreview, isAllowedPreviewUrl, openPreview } = await import("./preview")

beforeEach(() => {
  FakeBrowserWindow.instances.length = 0
})

describe("isAllowedPreviewUrl", () => {
  it.each(["http://localhost:3000", "http://127.0.0.1", "https://[::1]:8443", "https://localhost"])(
    "allows loopback url %s",
    (url) => {
      expect(isAllowedPreviewUrl(url)).toBe(true)
    },
  )

  it.each([
    "https://example.com",
    "http://localhost.evil.com",
    "http://127.0.0.1.evil.com",
    "file:///tmp/index.html",
    "javascript:alert(1)",
    "",
    "not a url",
  ])("rejects non-loopback url %s", (url) => {
    expect(isAllowedPreviewUrl(url)).toBe(false)
  })
})

describe("openPreview", () => {
  it("loads allowed urls in a sandboxed window", () => {
    const result = openPreview("http://localhost:3000")
    const [window] = FakeBrowserWindow.instances

    expect(result.id).toMatch(/[0-9a-f-]{36}/)
    expect(FakeBrowserWindow.instances).toHaveLength(1)
    expect(window?.url).toBe("http://localhost:3000")
    expect(window?.options).toMatchObject({
      width: 1100,
      height: 800,
      webPreferences: {
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        partition: "persist:pigcode-browser",
      },
    })
  })

  it("blocks navigation and popups that leave loopback", () => {
    openPreview("http://localhost:3000")
    const [window] = FakeBrowserWindow.instances
    const contents = window?.webContents

    expect(contents?.emitNavigation("will-navigate", "file:///etc/passwd")).toBe(true)
    expect(contents?.emitNavigation("will-redirect", "javascript:alert(1)")).toBe(true)
    expect(contents?.emitNavigation("will-navigate", "https://example.com")).toBe(true)
    expect(contents?.emitNavigation("will-redirect", "https://example.com")).toBe(true)
    expect(contents?.emitNavigation("will-navigate", "http://localhost.evil.com")).toBe(true)
    expect(contents?.openHandler?.({ url: "pigcode://app/index.html" })).toEqual({ action: "deny" })
    expect(contents?.openHandler?.({ url: "https://example.com" })).toEqual({ action: "deny" })
    expect(contents?.openHandler?.({ url: "about:blank" })).toEqual({ action: "allow" })
    expect(contents?.openHandler?.({ url: "http://localhost:5173" })).toEqual({ action: "allow" })
  })

  it("blocks subframe navigation that leaves loopback", () => {
    openPreview("http://localhost:3000")
    const [window] = FakeBrowserWindow.instances
    const contents = window?.webContents

    // 子框架的初始地址与跳转不能指向远程主机，空白框架不拦。
    expect(contents?.emitFrameNavigation("https://example.com", false)).toBe(true)
    expect(contents?.emitFrameNavigation("http://127.0.0.1.evil.com", false)).toBe(true)
    expect(contents?.emitFrameNavigation("about:blank", false)).toBe(false)
    expect(contents?.emitFrameNavigation("http://localhost:3000/embed", false)).toBe(false)
    // 主框架由 will-navigate 负责，这里不重复拦。
    expect(contents?.emitFrameNavigation("https://example.com", true)).toBe(false)
  })

  it("applies the same rules to windows opened from a preview", () => {
    openPreview("http://localhost:3000")
    const [parent] = FakeBrowserWindow.instances
    const child = new FakeBrowserWindow({})
    parent?.webContents.emitDidCreateWindow(child)

    expect(child.webContents.emitNavigation("will-navigate", "https://example.com")).toBe(true)
    expect(child.webContents.emitFrameNavigation("https://example.com", false)).toBe(true)
    expect(child.webContents.openHandler?.({ url: "https://example.com" })).toEqual({
      action: "deny",
    })

    // 弹窗也在 previewClose 的管理范围内。
    closePreview()
    expect(child.closed).toBe(true)
  })

  it("throws PREVIEW_URL_NOT_ALLOWED for other protocols and remote hosts", () => {
    expect(() => openPreview("file:///tmp/index.html")).toThrow("PREVIEW_URL_NOT_ALLOWED")
    expect(() => openPreview("about:blank")).toThrow("PREVIEW_URL_NOT_ALLOWED")
    expect(() => openPreview("https://example.com")).toThrow("PREVIEW_URL_NOT_ALLOWED")
    expect(FakeBrowserWindow.instances).toHaveLength(0)
  })

  it("closes a preview by id", () => {
    const { id } = openPreview("http://127.0.0.1:5173")
    const [window] = FakeBrowserWindow.instances

    closePreview(id)

    expect(window?.closed).toBe(true)
  })

  it("closes every preview when no id is given", () => {
    openPreview("http://localhost:3000")
    openPreview("https://[::1]:8443")

    closePreview()

    expect(FakeBrowserWindow.instances.every((window) => window.closed)).toBe(true)
  })
})
