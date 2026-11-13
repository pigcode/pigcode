/** 验证三平台窗口选项保持 sandbox，并把窗口按钮交给系统绘制。 */
import { describe, expect, it } from "vitest"
import {
  TITLE_BAR_HEIGHT,
  TRAFFIC_LIGHT_POSITION,
  createMainWindowOptions,
  defaultTitleBarColors,
  readTitleBarColors,
  windowBackground,
  windowMaterial,
} from "./window-options"

function optionsFor(platform: NodeJS.Platform, dark = false) {
  return createMainWindowOptions({
    platform,
    preloadPath: "/tmp/preload.cjs",
    isPackaged: true,
    dark,
  })
}

describe("createMainWindowOptions", () => {
  it("keeps native traffic lights on macOS without an overlay", () => {
    const options = optionsFor("darwin")
    expect(options.webPreferences?.sandbox).toBe(true)
    expect(options.titleBarStyle).toBe("hiddenInset")
    expect(options.trafficLightPosition).toEqual(TRAFFIC_LIGHT_POSITION)
    expect(options.titleBarOverlay).toBeUndefined()
  })

  it("uses mica and native caption buttons on Windows", () => {
    const options = optionsFor("win32")
    expect(options.backgroundMaterial).toBe("mica")
    expect(options.titleBarStyle).toBe("hidden")
    expect(options.titleBarOverlay).toEqual({
      ...defaultTitleBarColors(false),
      height: TITLE_BAR_HEIGHT,
    })
  })

  it("uses native caption buttons on Linux", () => {
    const options = optionsFor("linux")
    expect(options.webPreferences?.sandbox).toBe(true)
    expect(options.backgroundMaterial).toBeUndefined()
    expect(options.titleBarStyle).toBe("hidden")
    expect(options.titleBarOverlay).toEqual({
      ...defaultTitleBarColors(false),
      height: TITLE_BAR_HEIGHT,
    })
  })

  it("starts with dark colors when the system is dark", () => {
    const options = optionsFor("linux", true)
    expect(options.backgroundColor).toBe(defaultTitleBarColors(true)?.color)
    expect(options.titleBarOverlay).toMatchObject(defaultTitleBarColors(true) ?? {})
  })
})

describe("defaultTitleBarColors", () => {
  it("comes from the bundled tokens.css window and secondary text colours", () => {
    // 期望值是 Chromium 把 --window / --fg-2 画进画布读出的像素；深色图标色以前手抄成了 #D4D4D8
    expect(defaultTitleBarColors(false)).toEqual({ color: "#EEF0F5", symbolColor: "#3F3F46" })
    expect(defaultTitleBarColors(true)).toEqual({ color: "#0B0C0F", symbolColor: "#CACACC" })
    expect(readTitleBarColors(defaultTitleBarColors(true))).not.toBeNull()
  })
})

describe("readTitleBarColors", () => {
  it("accepts six-digit hex colors", () => {
    expect(readTitleBarColors({ color: "#f1f1f1", symbolColor: "#3F3F46" })).toEqual({
      color: "#f1f1f1",
      symbolColor: "#3F3F46",
    })
  })

  it("rejects other color syntaxes and malformed input", () => {
    expect(readTitleBarColors({ color: "red", symbolColor: "#000000" })).toBeNull()
    expect(readTitleBarColors({ color: "#fff", symbolColor: "#000000" })).toBeNull()
    expect(readTitleBarColors({ color: "#ffffff" })).toBeNull()
    expect(readTitleBarColors("#ffffff")).toBeNull()
    expect(readTitleBarColors(null)).toBeNull()
  })
})

describe("windowBackground", () => {
  it("uses eight-digit clear black when translucent, never the word transparent", () => {
    // Electron 把 "transparent" 解析成白色，磨砂材质会被白底挡住
    expect(windowBackground(true, false)).toBe("#00000000")
    expect(windowBackground(true, true)).toBe("#00000000")
  })

  it("goes back to the default window color when opaque", () => {
    expect(windowBackground(false, false)).toBe(defaultTitleBarColors(false)?.color)
    expect(windowBackground(false, true)).toBe(defaultTitleBarColors(true)?.color)
  })
})

describe("windowMaterial", () => {
  it("swaps to the clearer material while translucent and back afterwards", () => {
    expect(windowMaterial("darwin", true)).toEqual({ vibrancy: "fullscreen-ui" })
    expect(windowMaterial("darwin", false)).toEqual({ vibrancy: "sidebar" })
    expect(windowMaterial("win32", true)).toEqual({ backgroundMaterial: "acrylic" })
    expect(windowMaterial("win32", false)).toEqual({ backgroundMaterial: "mica" })
    expect(windowMaterial("linux", true)).toBeNull()
  })

  it("the opaque material is the one the window is created with", () => {
    const mac = createMainWindowOptions({ platform: "darwin", preloadPath: "/p", isPackaged: true })
    expect(windowMaterial("darwin", false)).toEqual({ vibrancy: mac.vibrancy })
    const win = createMainWindowOptions({ platform: "win32", preloadPath: "/p", isPackaged: true })
    expect(windowMaterial("win32", false)).toEqual({ backgroundMaterial: win.backgroundMaterial })
  })
})
