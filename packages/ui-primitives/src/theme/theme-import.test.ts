import { describe, expect, it } from "vitest"
import { defaultAppearance, editSlot, setOverride } from "./appearance-settings"
import { deriveAppearance } from "./appearance-tokens"
import { effectiveColors } from "./theme-code"
import { exportCurrentTheme, importTheme, themeNameFromFile } from "./theme-import"
import type { ThemeDefinition } from "./theme-presets"

const env = (platform: string, resolved: "light" | "dark" = "light", systemVersion = "") => ({
  resolved,
  glass: false,
  platform,
  systemVersion,
  prefersReducedMotion: false,
})

describe("theme import and export", () => {
  it("exports both modes and imports them back as one of my themes", () => {
    let settings = editSlot(defaultAppearance, "dark", { themeId: "nord" })
    settings = setOverride(settings, "dark", "diffAdded", "#22CC66")
    const file = exportCurrentTheme(settings, [])
    expect(file.name).toBe("pigcode + Nord")
    expect(file.fileName).toBe("pigcode-nord.pigcode-theme.json")
    const result = importTheme(file.text, "ignored", [])
    if (!result.ok) throw new Error(result.reason)
    expect(result.modes).toEqual(["light", "dark"])
    expect(result.theme.name).toBe("pigcode + Nord")
    expect(result.theme.builtIn).toBe(false)
    expect(result.theme.dark).toEqual(effectiveColors(settings, [], "dark"))
    expect(result.theme.light).toEqual(effectiveColors(settings, [], "light"))
  })

  it("imported theme drives the same colors once selected", () => {
    const settings = editSlot(defaultAppearance, "dark", { themeId: "dracula" })
    const result = importTheme(exportCurrentTheme(settings, []).text, "x", [])
    if (!result.ok) throw new Error(result.reason)
    const custom: ThemeDefinition[] = [result.theme]
    const picked = editSlot(defaultAppearance, "dark", { themeId: result.theme.id })
    const vars = deriveAppearance(picked, custom, env("darwin", "dark")).vars
    expect(vars["--bg"]).toBe("#282A36")
    expect(vars["--primary"]).toBe("#BD93F9")
  })

  it("imports a Codex code as a single-mode theme named after the file", () => {
    const code =
      'codex-theme-v1:{"codeThemeId":"x","variant":"dark","theme":{"accent":"#7aa2f7","ink":"#c0caf5","surface":"#1a1b26"}}'
    const existing = [{ id: "a", name: "tokyo", builtIn: false, light: null, dark: null }]
    const result = importTheme(code, themeNameFromFile("/tmp/tokyo.txt"), existing)
    if (!result.ok) throw new Error(result.reason)
    expect(result.modes).toEqual(["dark"])
    expect(result.theme.name).toBe("tokyo 2")
    expect(result.theme.dark).toMatchObject({ bg: "#1A1B26", fg: "#C0CAF5", accent: "#7AA2F7" })
  })

  it("reports why a file cannot be imported", () => {
    expect(importTheme('{"schema":"other"}', "x", [])).toEqual({
      ok: false,
      reason: "settings.appearance.themeFile.wrongSchema",
    })
    expect(importTheme("garbage", "x", [])).toEqual({
      ok: false,
      reason: "settings.appearance.code.notCode",
    })
  })

  it("never reuses a built-in theme name", () => {
    const code = '{"theme":{"surface":"#101010","ink":"#EEEEEE"}}'
    const result = importTheme(code, "Nord", [])
    if (!result.ok) throw new Error(result.reason)
    expect(result.theme.name).toBe("Nord 2")
  })

  it("strips folders and theme extensions from file names", () => {
    expect(themeNameFromFile("C:\\themes\\Night Owl.pigcode-theme.json")).toBe("Night Owl")
    expect(themeNameFromFile("a/b/solar.json")).toBe("solar")
  })
})

describe("sidebar translucency", () => {
  it("makes the window color translucent only where the system has a material", () => {
    const settings = { ...defaultAppearance, sidebarTranslucency: 100 }
    const mac = deriveAppearance(settings, [], env("darwin"))
    expect(mac.attrs["data-translucent"]).toBe("true")
    expect(mac.vars["--window"]).toMatch(/^rgb\(\d+ \d+ \d+ \/ 0\)$/)
    expect(mac.vars["--window-solid"]).toMatch(/^#[0-9A-F]{6}$/)
    // Windows 11 22H2 以上才有 acrylic；Windows 10 打开透明只会变黑，所以不开
    expect(deriveAppearance(settings, [], env("win32", "light", "10.0.22631")).attrs).toMatchObject(
      {
        "data-translucent": "true",
      },
    )
    expect(deriveAppearance(settings, [], env("win32", "light", "10.0.19045"))).toEqual({
      vars: {},
      attrs: {},
    })
    expect(deriveAppearance(settings, [], env("linux"))).toEqual({ vars: {}, attrs: {} })
    expect(deriveAppearance(settings, [], env(""))).toEqual({ vars: {}, attrs: {} })
  })

  it("follows a custom background and stays off at zero", () => {
    const themed = { ...editSlot(defaultAppearance, "light", { themeId: "nord" }) }
    const off = deriveAppearance(themed, [], env("darwin"))
    expect(off.attrs["data-translucent"]).toBeUndefined()
    const on = deriveAppearance({ ...themed, sidebarTranslucency: 40 }, [], env("darwin"))
    expect(on.vars["--window"]).toMatch(/ \/ 0\.6\)$/)
    expect(on.vars["--window"]).not.toBe(off.vars["--window"])
  })
})
