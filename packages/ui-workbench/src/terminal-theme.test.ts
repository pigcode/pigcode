/** 验证终端配色由 --term-* token 生成，并和标题栏、外观设置一起跟随主题颜色变化。 */
import { readFileSync } from "node:fs"
import { createRequire } from "node:module"
import {
  defaultAppearance,
  deriveAppearance,
  parseCssColor,
  titleBarColors,
  tokenBlock,
  tokenReader,
  type AppearanceSettings,
  type ColorResolver,
} from "@pigcode/ui-primitives"
import { describe, expect, it } from "vitest"
import { terminalTheme } from "./terminal-theme"

const css = readFileSync(
  createRequire(import.meta.url).resolve("@pigcode/ui-primitives/styles/tokens.css"),
  "utf8",
)

/** 模拟浏览器里 <html> 的计算值：tokens.css 的明暗块叠上外观设置写的内联变量。 */
function pageTokens(settings: AppearanceSettings, tone: "light" | "dark") {
  const { vars } = deriveAppearance(settings, [], {
    resolved: tone,
    glass: false,
    platform: "linux",
    prefersReducedMotion: false,
  })
  return tokenReader({ ...tokenBlock(css, tone), ...vars })
}

/** jsdom 解析不了 color-mix；测试里把它记成可辨认的占位，其余交给纯函数解析。 */
const resolve: ColorResolver = (value) =>
  value.startsWith("color-mix(") ? `mix:${value}` : parseCssColor(value)

const ANSI = [
  "black",
  "red",
  "green",
  "yellow",
  "blue",
  "magenta",
  "cyan",
  "white",
  "brightBlack",
  "brightRed",
  "brightGreen",
  "brightYellow",
  "brightBlue",
  "brightMagenta",
  "brightCyan",
  "brightWhite",
] as const

describe("terminalTheme", () => {
  it.each(["light", "dark"] as const)("fills every xterm colour from %s tokens", (tone) => {
    const read = pageTokens(defaultAppearance, tone)
    const theme = terminalTheme(read, resolve)
    for (const key of ANSI) expect(theme[key], key).toMatch(/^#[0-9A-F]{6}$/)
    expect(theme.background).toBe(parseCssColor(read("--term-bg")))
    expect(theme.foreground).toBe(parseCssColor(read("--term-fg")))
    expect(theme.cursorAccent).toBe(theme.background)
    expect(theme.cursor).toBe(parseCssColor(read("--primary")))
    expect(theme.selectionBackground).toMatch(/^mix:color-mix\(in srgb, oklch/)
  })

  it("derives the semantic ANSI colours from the status tokens", () => {
    const dark = pageTokens(defaultAppearance, "dark")
    const theme = terminalTheme(dark, resolve)
    expect(theme.red).toBe(parseCssColor(dark("--bad")))
    expect(theme.green).toBe(parseCssColor(dark("--ok")))
    expect(theme.yellow).toBe(parseCssColor(dark("--warn")))
    expect(theme.blue).toBe(parseCssColor(dark("--info")))
    const light = terminalTheme(pageTokens(defaultAppearance, "light"), resolve)
    expect(light.red).toBe(parseCssColor(pageTokens(defaultAppearance, "light")("--bad-text")))
  })

  it("leaves out colours the resolver cannot read", () => {
    expect(
      terminalTheme(
        () => "",
        () => null,
      ),
    ).toEqual({})
  })

  it("moves the cursor, selection and title bar together when a theme colour changes", () => {
    const accent = "#D97757"
    const bg = "#262624"
    const settings: AppearanceSettings = {
      ...defaultAppearance,
      light: { ...defaultAppearance.light, accentMode: "custom" },
      overrides: { pigcode: { dark: { accent, bg } } },
    }
    const before = pageTokens(defaultAppearance, "dark")
    const after = pageTokens(settings, "dark")

    // 外观设置里显示的强调色就是终端光标色，选区也换成了同一个强调色
    expect(settings.overrides["pigcode"]?.dark?.accent).toBe(accent)
    const theme = terminalTheme(after, resolve)
    expect(theme.cursor).toBe(accent)
    expect(theme.selectionBackground).toBe(`mix:color-mix(in srgb, ${accent} 25%, transparent)`)
    expect(terminalTheme(before, resolve).cursor).not.toBe(accent)

    // 终端底色跟着主题背景变；默认设置下不写，仍是 tokens.css 的值
    expect(theme.background).not.toBe(terminalTheme(before, resolve).background)
    expect(terminalTheme(before, resolve).background).toBe("#161616")

    // 标题栏底色跟着换了背景的窗口底色
    const bar = titleBarColors(after, parseCssColor)
    expect(bar?.color).toBe(after("--window"))
    expect(bar?.color).not.toBe(titleBarColors(before, parseCssColor)?.color)
  })

  it("keeps the default terminal background when a theme background does not match the mode", () => {
    const settings: AppearanceSettings = {
      ...defaultAppearance,
      overrides: { pigcode: { light: { bg: "#262624" } } },
    }
    const light = terminalTheme(pageTokens(settings, "light"), resolve)
    expect(light.background).toBe(
      terminalTheme(pageTokens(defaultAppearance, "light"), resolve).background,
    )
  })

  it("uses the theme text colour for terminal text", () => {
    const fg = "#E6E1D6"
    const settings: AppearanceSettings = {
      ...defaultAppearance,
      overrides: { pigcode: { dark: { fg } } },
    }
    expect(terminalTheme(pageTokens(settings, "dark"), resolve).foreground).toBe(fg)
    expect(terminalTheme(pageTokens(defaultAppearance, "dark"), resolve).foreground).toBe("#E4E4E7")
  })
})
