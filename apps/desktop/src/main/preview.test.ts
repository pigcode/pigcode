/** 验证预览窗口只接受 loopback http/https，并在沙箱窗口中加载。 */
import { beforeEach, describe, expect, it, vi } from "vitest"

/** 用最小 BrowserWindow 替身捕获构造参数、加载 URL 与关闭动作。 */
const { FakeBrowserWindow } = vi.hoisted(() => {
  class FakeBrowserWindow {
    static instances: FakeBrowserWindow[] = []

    readonly options: unknown
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
      webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true },
    })
  })

  it("throws PREVIEW_URL_NOT_ALLOWED for non-loopback urls", () => {
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
