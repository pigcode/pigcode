/** 验证关窗口和托盘文案：各平台的行为和两种语言的文案。 */
import { describe, expect, it } from "vitest"
import { hidesOnClose } from "./lifecycle"
import { trayLabels } from "./locale/tray"

describe("closing the window", () => {
  it("hides on macOS and Windows, and quits on Linux", () => {
    expect(hidesOnClose("darwin")).toBe(true)
    expect(hidesOnClose("win32")).toBe(true)
    // GNOME 默认不显示托盘图标：隐藏以后可能找不回窗口。
    expect(hidesOnClose("linux")).toBe(false)
  })
})

describe("tray labels", () => {
  it("follows the system language", () => {
    expect(trayLabels("zh-CN").open).toBe("打开窗口")
    expect(trayLabels("zh-Hans").quit).toContain("退出")
    expect(trayLabels("en-US").open).toBe("Open Window")
    expect(trayLabels("de-DE").open).toBe("Open Window")
  })
})
