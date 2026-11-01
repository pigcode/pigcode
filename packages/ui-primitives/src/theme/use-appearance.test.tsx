/** 验证 useAppearance 把当前外观的 --window / --fg-2 报给原生标题栏，颜色不变时不重复上报。 */
// @vitest-environment jsdom
import { readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { act, cleanup, renderHook } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { defaultAppearance } from "./appearance-settings"
import { parseCssColor, tokenBlock, tokenReader } from "./theme-tokens"
import { useAppearance } from "./use-appearance"

// jsdom 环境里的 URL 是 jsdom 的实现，node:fs 不收，所以按路径拼
const css = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), "../styles/tokens.css"),
  "utf8",
)

/** jsdom 不加载 tokens.css、也不会解析 oklch：用 tokens.css 原文叠上 <html> 的内联变量代替计算值。 */
vi.mock("./resolve-color", () => ({
  documentTokenReader: () => {
    const root = document.documentElement
    const tone = root.dataset.theme === "dark" ? "dark" : "light"
    const inline: Record<string, string> = {}
    for (const name of Array.from(root.style)) inline[name] = root.style.getPropertyValue(name)
    return tokenReader({ ...tokenBlock(css, tone), ...inline })
  },
  resolveCssColor: parseCssColor,
}))

describe("useAppearance title bar", () => {
  const setTitleBarColors = vi.fn(() => Promise.resolve())

  beforeEach(() => {
    window.localStorage.clear()
    vi.stubGlobal("matchMedia", (query: string) => ({
      matches: false,
      media: query,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
    }))
    window.pigcodeNative = {
      platform: "linux",
      setThemeSource: () => Promise.resolve(),
      windowControl: () => Promise.resolve(),
      isMaximized: () => Promise.resolve(false),
      previewOpen: () => Promise.resolve({ id: "" }),
      previewClose: () => undefined,
      setTitleBarColors,
    }
  })

  afterEach(() => {
    cleanup()
    vi.unstubAllGlobals()
    setTitleBarColors.mockClear()
    delete window.pigcodeNative
    document.documentElement.removeAttribute("style")
  })

  it("reports the theme's window colour and follows theme changes", () => {
    const { result, rerender } = renderHook(() => useAppearance())
    expect(setTitleBarColors).toHaveBeenLastCalledWith({ color: "#F1F1F1", symbolColor: "#3F3F46" })

    act(() => result.current.update({ ...defaultAppearance, mode: "dark" }))
    expect(setTitleBarColors).toHaveBeenLastCalledWith({ color: "#0D0D0D", symbolColor: "#CACACC" })

    act(() =>
      result.current.update({
        ...defaultAppearance,
        mode: "dark",
        overrides: { pigcode: { dark: { bg: "#262624", fg: "#FAF9F5" } } },
      }),
    )
    const root = document.documentElement.style
    expect(setTitleBarColors).toHaveBeenLastCalledWith({
      color: root.getPropertyValue("--window").toUpperCase(),
      symbolColor: root.getPropertyValue("--fg-2").toUpperCase(),
    })

    const calls = setTitleBarColors.mock.calls.length
    rerender()
    act(() => result.current.update((current) => ({ ...current })))
    expect(setTitleBarColors).toHaveBeenCalledTimes(calls)
  })
})
