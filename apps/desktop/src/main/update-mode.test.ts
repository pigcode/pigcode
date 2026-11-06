/** 验证哪些平台能自己安装更新，以及开发运行时不做。 */
import { describe, expect, it } from "vitest"
import { canInstallUpdates, canReplaceApp, updateMode } from "./update-mode"

describe("update mode", () => {
  it("installs updates on Windows and in an AppImage", () => {
    expect(updateMode("win32", {})).toBe("install")
    expect(updateMode("linux", { APPIMAGE: "/tmp/Pigcode.AppImage" })).toBe("install")
  })

  it("hands macOS the full package to replace by hand", () => {
    // 没签名装不了，但可以下载 DMG 打开，让用户把 .app 拖进「应用程序」。
    expect(updateMode("darwin", {})).toBe("replace")
  })

  it("only points at the download page for deb packages", () => {
    // deb 要输入系统密码，而且每次全量下载。
    expect(updateMode("linux", {})).toBe("notify")
    expect(updateMode("linux", { APPIMAGE: "" })).toBe("notify")
  })

  it("does not try to install while running from source", () => {
    expect(canInstallUpdates("install", true)).toBe(true)
    expect(canInstallUpdates("install", false)).toBe(false)
    expect(canInstallUpdates("notify", true)).toBe(false)
    // 换包这条路同样只在打包后可用：开发运行时没有可替换的 .app。
    expect(canReplaceApp("replace", true)).toBe(true)
    expect(canReplaceApp("replace", false)).toBe(false)
    expect(canReplaceApp("install", true)).toBe(false)
  })
})
