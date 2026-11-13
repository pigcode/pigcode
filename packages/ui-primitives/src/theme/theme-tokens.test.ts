/** 验证 tokens.css 的解析、var() 展开、无浏览器取色，以及标题栏颜色随外观设置变化。 */
import { readFileSync } from "node:fs"
import { describe, expect, it } from "vitest"
import { defaultAppearance, type AppearanceSettings } from "./appearance-settings"
import { deriveAppearance, type AppearanceEnvironment } from "./appearance-tokens"
import { oklchToHex } from "./color-math"
import { parseCssColor, titleBarColors, tokenBlock, tokenReader } from "./theme-tokens"

const css = readFileSync(new URL("../styles/tokens.css", import.meta.url), "utf8")

const env = (resolved: "light" | "dark"): AppearanceEnvironment => ({
  resolved,
  glass: false,
  platform: "linux",
  prefersReducedMotion: false,
})

/** 模拟浏览器：tokens.css 的明暗块，再叠上外观设置写到 <html> 的内联变量。 */
function pageTokens(settings: AppearanceSettings, tone: "light" | "dark") {
  const { vars } = deriveAppearance(settings, [], env(tone))
  return { vars, read: tokenReader({ ...tokenBlock(css, tone), ...vars }) }
}

describe("tokenBlock", () => {
  it("reads the light block from :root and the dark block separately", () => {
    const light = tokenBlock(css, "light")
    const dark = tokenBlock(css, "dark")
    expect(light["--window"]).toBe("oklch(95.6% 0.006 264)")
    expect(dark["--window"]).toBe("oklch(15.4% 0.006 268)")
    expect(light["--term-red"]).toBe("var(--bad-text)")
    expect(dark["--term-red"]).toBe("var(--bad)")
  })

  it("ignores platform-specific rules", () => {
    expect(
      tokenBlock(":root[data-platform='x']:not([data-theme=\"dark\"]) { --a: 1; }", "light"),
    ).toEqual({})
  })
})

describe("tokenReader", () => {
  it("expands nested var() references and tolerates cycles", () => {
    const read = tokenReader({
      "--a": "var(--b)",
      "--b": "var(--c)",
      "--c": "x",
      "--loop": "var(--loop)",
    })
    expect(read("--a")).toBe("x")
    expect(read("--loop")).toBe("")
    expect(read("--missing")).toBe("")
  })
})

describe("parseCssColor", () => {
  it("matches what Chromium paints for oklch tokens", () => {
    // 期望值是 Electron 43（Chromium 150）把同一 oklch 画进 1×1 画布读出的像素
    expect(parseCssColor("oklch(16% 0 0)")).toBe("#0D0D0D")
    expect(parseCssColor("oklch(95.8% 0 0)")).toBe("#F1F1F1")
    expect(parseCssColor("oklch(52% 0.2 264)")).toBe("#2A5CDA")
    expect(parseCssColor("oklch(84% 0.003 286)")).toBe("#CACACC")
    expect(parseCssColor("oklch(37% 0.012 286)")).toBe("#3F3F46")
    expect(parseCssColor("oklch(68% 0.18 25)")).toBe("#F3625D")
    expect(oklchToHex(1, 0, 0)).toBe("#FFFFFF")
  })

  it("accepts hex and rejects anything that needs a browser", () => {
    expect(parseCssColor("#161616")).toBe("#161616")
    expect(parseCssColor("color-mix(in srgb, red 10%, transparent)")).toBeNull()
    expect(parseCssColor("oklch(52% 0.2 264 / 0.5)")).toBeNull()
  })
})

describe("titleBarColors", () => {
  it("takes --window and --fg-2 from the default theme", () => {
    const { read } = pageTokens(defaultAppearance, "dark")
    expect(titleBarColors(read, parseCssColor)).toEqual({
      color: parseCssColor("oklch(15.4% 0.006 268)"),
      symbolColor: parseCssColor("oklch(84% 0.003 286)"),
    })
  })

  it("follows a changed theme background and text colour", () => {
    const settings: AppearanceSettings = {
      ...defaultAppearance,
      overrides: { pigcode: { light: { bg: "#FDF6E3", fg: "#586E75" } } },
    }
    const before = titleBarColors(pageTokens(defaultAppearance, "light").read, parseCssColor)
    const { vars, read } = pageTokens(settings, "light")
    const after = titleBarColors(read, parseCssColor)
    expect(after).toEqual({ color: vars["--window"], symbolColor: vars["--fg-2"] })
    expect(after?.color).not.toBe(before?.color)
    expect(after?.symbolColor).not.toBe(before?.symbolColor)
  })

  it("gives up when the window colour is translucent", () => {
    const read = tokenReader({ "--window": "transparent", "--fg-2": "#000000" })
    const resolve = (value: string) => (value === "transparent" ? "#00000000" : value)
    expect(titleBarColors(read, resolve)).toBeNull()
  })
})
