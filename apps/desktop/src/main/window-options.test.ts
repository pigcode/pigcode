/** 验证三平台窗口选项保持 sandbox 与标题栏设置。 */
import { describe, expect, it } from "vitest"
import { createMainWindowOptions } from "./window-options"

describe("createMainWindowOptions", () => {
  it("keeps sandbox on macOS", () => {
    const options = createMainWindowOptions({
      platform: "darwin",
      preloadPath: "/tmp/preload.cjs",
      isPackaged: true,
    })
    expect(options.webPreferences?.sandbox).toBe(true)
    expect(options.titleBarStyle).toBe("hiddenInset")
  })

  it("uses mica on Windows", () => {
    const options = createMainWindowOptions({
      platform: "win32",
      preloadPath: "/tmp/preload.cjs",
      isPackaged: true,
    })
    expect(options.backgroundMaterial).toBe("mica")
  })
})
