/** 验证三平台窗口选项保持 sandbox，并把窗口按钮交给系统绘制。 */
import { describe, expect, it } from "vitest"
import {
  TITLE_BAR_HEIGHT,
  TRAFFIC_LIGHT_POSITION,
  createMainWindowOptions,
  defaultTitleBarColors,
  readTitleBarColors,
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
    expect(options.backgroundColor).toBe(defaultTitleBarColors(true).color)
    expect(options.titleBarOverlay).toMatchObject(defaultTitleBarColors(true))
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
