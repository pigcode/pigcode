/** 验证主题与语言的观察器：读取根元素的属性，变化时通知订阅者。 */
// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest"
import { observeLocale, observeTheme } from "./observers"

afterEach(() => {
  document.documentElement.removeAttribute("data-theme")
  document.documentElement.removeAttribute("lang")
})

describe("observers", () => {
  it("follow the root element's theme and language", async () => {
    const theme = observeTheme()
    const locale = observeLocale()
    expect(theme.get()).toBe("light")
    expect(locale.get()).toBe("zh-CN")
    const seen: string[] = []
    const stop = theme.subscribe((value) => seen.push(value))
    document.documentElement.setAttribute("data-theme", "dark")
    document.documentElement.setAttribute("lang", "en-US")
    await Promise.resolve()
    expect(seen).toEqual(["dark"])
    expect(locale.get()).toBe("en-US")
    stop()
    document.documentElement.setAttribute("data-theme", "light")
    await Promise.resolve()
    expect(seen).toEqual(["dark"])
  })
})
