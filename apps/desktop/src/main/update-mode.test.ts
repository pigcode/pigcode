/** 验证哪些平台能自己安装更新，以及开发运行时不做。 */
import { describe, expect, it } from "vitest"
import { canInstallUpdates, updateMode } from "./update-mode"

describe("update mode", () => {
  it("installs updates on Windows and in an AppImage", () => {
    expect(updateMode("win32", {})).toBe("install")
    expect(updateMode("linux", { APPIMAGE: "/tmp/Pigcode.AppImage" })).toBe("install")
  })

  it("only points at the download page on macOS and for deb packages", () => {
    // macOS 的包没签名，electron-updater 装不了。
    expect(updateMode("darwin", {})).toBe("notify")
    // deb 要输入系统密码，而且每次全量下载。
    expect(updateMode("linux", {})).toBe("notify")
    expect(updateMode("linux", { APPIMAGE: "" })).toBe("notify")
  })

  it("does not try to install while running from source", () => {
    expect(canInstallUpdates("install", true)).toBe(true)
    expect(canInstallUpdates("install", false)).toBe(false)
    expect(canInstallUpdates("notify", true)).toBe(false)
  })
})
