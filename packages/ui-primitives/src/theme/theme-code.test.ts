import { describe, expect, it } from "vitest"
import {
  defaultAppearance,
  editSlot,
  parseStoredAppearance,
  resetMode,
  serializeAppearance,
  setOverride,
} from "./appearance-settings"
import { deriveAppearance } from "./appearance-tokens"
import {
  applyThemeCode,
  decodeThemeCode,
  encodeThemeCode,
  explicitColors,
  fontDisplayName,
  fontFromDisplayName,
  themeCodePrefix,
} from "./theme-code"

const env = {
  resolved: "dark" as const,
  glass: false,
  platform: "darwin",
  prefersReducedMotion: false,
}

describe("theme code", () => {
  it("default pigcode encodes all five colors and re-applies without adding changes", () => {
    const code = encodeThemeCode(defaultAppearance, [], "dark")
    expect(code.startsWith(themeCodePrefix)).toBe(true)
    const json = JSON.parse(code.slice(themeCodePrefix.length)) as {
      themeId: string
      variant: string
      theme: Record<string, unknown>
    }
    expect(json.themeId).toBe("pigcode")
    expect(json.variant).toBe("dark")
    expect(Object.keys(json.theme)).toEqual([
      "accent",
      "surface",
      "ink",
      "contrast",
      "fonts",
      "semanticColors",
    ])
    const decoded = decodeThemeCode(code)
    if (!decoded.ok) throw new Error(decoded.reason)
    const applied = applyThemeCode(defaultAppearance, [], "dark", decoded.code)
    expect(applied.overrides).toEqual({})
    expect(applied.dark.accentMode).toBe("default")
    expect(deriveAppearance(applied, [], env)).toEqual({ vars: {}, attrs: {} })
  })

  it("round-trips a preset with edited colors, diff colors, fonts and contrast", () => {
    let settings = editSlot(defaultAppearance, "dark", { themeId: "github", accentMode: "custom" })
    settings = setOverride(settings, "dark", "accent", "#FF00AA")
    settings = setOverride(settings, "dark", "diffAdded", "#22CC66")
    settings = { ...settings, contrast: 70, codeFont: "jetbrains" }
    settings = { ...settings, light: { ...settings.light, uiFont: "Avenir Next" } }
    settings = { ...settings, dark: { ...settings.dark, uiFont: "Avenir Next" } }
    const code = encodeThemeCode(settings, [], "dark")
    const decoded = decodeThemeCode(code)
    if (!decoded.ok) throw new Error(decoded.reason)
    expect(decoded.code.fonts).toEqual({ ui: "Avenir Next", code: "jetbrains" })
    const applied = applyThemeCode(defaultAppearance, [], "dark", decoded.code)
    expect(explicitColors(applied, [], "dark")).toEqual(explicitColors(settings, [], "dark"))
    expect(deriveAppearance(applied, [], env)).toEqual(deriveAppearance(settings, [], env))
  })

  it("reads a Codex theme string and keeps the other mode unchanged", () => {
    const codex = `codex-theme-v1:${JSON.stringify({
      codeThemeId: "matrix",
      variant: "dark",
      theme: {
        accent: "#7aa2f7",
        contrast: 60,
        ink: "#c0caf5",
        surface: "#1a1b26",
        opaqueWindows: false,
        fonts: { ui: null, code: "JetBrains Mono" },
        semanticColors: { diffAdded: "#9ece6a", diffRemoved: "#f7768e", skill: "#bb9af7" },
      },
    })}`
    const decoded = decodeThemeCode(codex)
    if (!decoded.ok) throw new Error(decoded.reason)
    const before = editSlot(defaultAppearance, "light", { themeId: "nord" })
    const applied = applyThemeCode(before, [], "dark", decoded.code)
    expect(applied.dark.themeId).toBe("pigcode")
    expect(applied.dark.accentMode).toBe("custom")
    expect(applied.light.themeId).toBe("nord")
    expect(applied.contrast).toBe(60)
    expect(applied.codeFont).toBe("jetbrains")
    expect(explicitColors(applied, [], "dark")).toEqual({
      accent: "#7AA2F7",
      bg: "#1A1B26",
      fg: "#C0CAF5",
      diffAdded: "#9ECE6A",
      diffRemoved: "#F7768E",
    })
    const vars = deriveAppearance(applied, [], env).vars
    expect(vars["--cv-diff-added"]).toBe("#9ECE6A")
    expect(vars["--cv-added"]).toBeUndefined()
    expect(vars["--diff-remove-fg"]).toBe("#F7768E")
    expect(vars["--font-mono"]).toContain('"JetBrains Mono"')
  })

  it("re-applying an unedited preset code keeps the theme's own colors as defaults", () => {
    const settings = editSlot(defaultAppearance, "dark", { themeId: "github" })
    const decoded = decodeThemeCode(encodeThemeCode(settings, [], "dark"))
    if (!decoded.ok) throw new Error(decoded.reason)
    expect(decoded.code.colors.accent).toBe("#2F81F7")
    const applied = applyThemeCode(settings, [], "dark", decoded.code)
    expect(applied.dark.accentMode).toBe("default")
    expect(applied.overrides).toEqual({})
  })

  it("a code with only contrast or fonts keeps the mode's theme and colors", () => {
    let settings = editSlot(defaultAppearance, "light", { themeId: "nord" })
    settings = setOverride(settings, "light", "bg", "#EEEEEE")
    const decoded = decodeThemeCode('{"theme":{"contrast":80,"fonts":{"code":"Menlo"}}}')
    if (!decoded.ok) throw new Error(decoded.reason)
    const applied = applyThemeCode(settings, [], "light", decoded.code)
    expect(applied.light.themeId).toBe("nord")
    expect(applied.overrides).toEqual(settings.overrides)
    expect(applied.contrast).toBe(80)
    expect(applied.codeFont).toBe("menlo")
  })

  it("rejects text that is not a theme code", () => {
    expect(decodeThemeCode("   ")).toEqual({ ok: false, reason: "settings.appearance.code.empty" })
    expect(decodeThemeCode("hello")).toEqual({
      ok: false,
      reason: "settings.appearance.code.notCode",
    })
    expect(decodeThemeCode(`${themeCodePrefix}{"theme":`)).toEqual({
      ok: false,
      reason: "settings.appearance.code.invalidJson",
    })
    expect(decodeThemeCode('{"theme":{"accent":"red"}}')).toEqual({
      ok: false,
      reason: "settings.appearance.code.nothing",
    })
  })

  it("drops bad colors and cleans font names", () => {
    const decoded = decodeThemeCode(
      '{"theme":{"accent":"blue","surface":"#101010","fonts":{"ui":"Evil\\"; } body { x","code":42}}}',
    )
    if (!decoded.ok) throw new Error(decoded.reason)
    expect(decoded.code.colors).toEqual({ bg: "#101010" })
    expect(decoded.code.fonts).toEqual({ ui: "Evil body x" })
  })
})

describe("appearance settings helpers", () => {
  it("editSlot splits modes without changing the other mode", () => {
    const shared = { ...defaultAppearance, light: { ...defaultAppearance.light, themeId: "nord" } }
    const next = editSlot(shared, "light", { themeId: "github" })
    expect(next.splitModes).toBe(true)
    expect(next.light.themeId).toBe("github")
    expect(next.dark.themeId).toBe("nord")
  })

  it("resetMode clears only that mode's colors", () => {
    let settings = editSlot(defaultAppearance, "light", { accentMode: "custom" })
    settings = setOverride(settings, "light", "accent", "#112233")
    settings = setOverride(settings, "dark", "bg", "#000000")
    const reset = resetMode(settings, "light")
    expect(reset.light.accentMode).toBe("default")
    expect(reset.overrides).toEqual({ pigcode: { dark: { bg: "#000000" } } })
  })

  it("keeps custom font names and diff overrides through storage", () => {
    let settings = { ...defaultAppearance, codeFont: "Berkeley Mono" }
    settings = setOverride(settings, "dark", "diffRemoved", "#FF0000")
    expect(parseStoredAppearance(serializeAppearance(settings))).toEqual(settings)
  })

  it("maps preset fonts to names and back", () => {
    expect(fontDisplayName("code", "fira")).toBe("Fira Code")
    expect(fontDisplayName("ui", "system")).toBe("")
    expect(fontFromDisplayName("code", "fira code")).toBe("fira")
    expect(fontFromDisplayName("ui", "  ")).toBe("system")
    expect(fontFromDisplayName("ui", "Avenir")).toBe("Avenir")
    expect(fontDisplayName("ui", "constructor")).toBe("constructor")
  })
})
