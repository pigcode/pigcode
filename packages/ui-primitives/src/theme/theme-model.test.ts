/** 验证主题解析与系统深色跟随。 */
import { describe, expect, it } from "vitest"
import { resolveTheme } from "./theme-model"

describe("resolveTheme", () => {
  it("follows the system preference", () => {
    expect(resolveTheme("system", true)).toBe("dark")
    expect(resolveTheme("system", false)).toBe("light")
  })

  it("keeps an explicit preference", () => {
    expect(resolveTheme("light", true)).toBe("light")
  })
})
