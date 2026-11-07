/** 验证内置浏览器的地址限制：能打开的地址、补全规则，以及交给系统浏览器的地址。 */
import { describe, expect, it } from "vitest"
import { isAllowedBrowserUrl, normalizeBrowserUrl, readBrowserExternalUrl } from "./browser-policy"

describe("browser policy", () => {
  it("allows http, https and about:blank only", () => {
    expect(isAllowedBrowserUrl("http://localhost:3000/")).toBe(true)
    expect(isAllowedBrowserUrl("https://example.com/")).toBe(true)
    expect(isAllowedBrowserUrl("about:blank")).toBe(true)
    expect(isAllowedBrowserUrl("file:///etc/passwd")).toBe(false)
    expect(isAllowedBrowserUrl("pigcode://app/index.html")).toBe(false)
  })

  it("completes addresses the same way as the address bar", () => {
    expect(normalizeBrowserUrl("3000")).toBe("http://localhost:3000/")
    expect(normalizeBrowserUrl("example.com")).toBe("https://example.com/")
    expect(normalizeBrowserUrl("javascript:alert(1)")).toBeNull()
  })

  it("hands only plain http and https pages to the system browser", () => {
    expect(readBrowserExternalUrl("http://localhost:5173/app")).toBe("http://localhost:5173/app")
    expect(readBrowserExternalUrl("https://example.com/docs")).toBe("https://example.com/docs")
    expect(readBrowserExternalUrl("https://user:secret@example.com/")).toBeNull()
    expect(readBrowserExternalUrl("about:blank")).toBeNull()
    expect(readBrowserExternalUrl("file:///etc/passwd")).toBeNull()
    expect(readBrowserExternalUrl(42)).toBeNull()
  })
})
