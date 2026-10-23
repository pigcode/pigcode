/** 验证快捷键按平台显示。 */
import { describe, expect, it } from "vitest"
import { formatShortcut } from "./shortcut"

describe("formatShortcut", () => {
  it("uses symbols on macOS", () => {
    expect(formatShortcut("Mod+n", true)).toBe("⌘N")
    expect(formatShortcut("Ctrl+`", true)).toBe("⌃`")
    expect(formatShortcut("Mod+Shift+k", true)).toBe("⌘⇧K")
    expect(formatShortcut("Mod+,", true)).toBe("⌘,")
  })

  it("spells out modifiers elsewhere", () => {
    expect(formatShortcut("Mod+n", false)).toBe("Ctrl+N")
    expect(formatShortcut("Ctrl+`", false)).toBe("Ctrl+`")
    expect(formatShortcut("Mod+Shift+k", false)).toBe("Ctrl+Shift+K")
    expect(formatShortcut("Mod+,", false)).toBe("Ctrl+,")
  })
})
