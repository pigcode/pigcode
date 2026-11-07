/** 验证偏好文件：默认值、损坏的字段、非法修改都不影响启动。 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import {
  DEFAULT_PREFERENCES,
  readPreferences,
  withPreference,
  writePreferences,
} from "./preferences"

const dirs: string[] = []

function tempPath(): string {
  const dir = mkdtempSync(join(tmpdir(), "pigcode-prefs-"))
  dirs.push(dir)
  return join(dir, "preferences.json")
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

describe("preferences", () => {
  it("starts from the defaults when there is no file", () => {
    expect(readPreferences(tempPath())).toEqual(DEFAULT_PREFERENCES)
    // 开机自启默认关，Dock 图标默认显示，自动检查开，但默认不接预发布，也不阻止电脑睡眠。
    expect(DEFAULT_PREFERENCES).toEqual({
      launchAtLogin: false,
      showInDock: true,
      autoCheckUpdates: true,
      prereleaseUpdates: false,
      keepAwake: false,
    })
  })

  it("keeps the good fields and ignores broken ones", () => {
    const path = tempPath()
    writeFileSync(path, JSON.stringify({ launchAtLogin: true, showInDock: "yes" }))
    expect(readPreferences(path)).toEqual({
      launchAtLogin: true,
      showInDock: true,
      autoCheckUpdates: true,
      prereleaseUpdates: false,
      keepAwake: false,
    })
    writeFileSync(path, "not json")
    expect(readPreferences(path)).toEqual(DEFAULT_PREFERENCES)
  })

  it("writes what it reads", () => {
    const path = tempPath()
    writePreferences(path, {
      launchAtLogin: true,
      showInDock: false,
      autoCheckUpdates: false,
      prereleaseUpdates: true,
      keepAwake: true,
    })
    expect(readPreferences(path)).toEqual({
      launchAtLogin: true,
      showInDock: false,
      autoCheckUpdates: false,
      prereleaseUpdates: true,
      keepAwake: true,
    })
  })

  it("only accepts known keys with boolean values", () => {
    const current = { ...DEFAULT_PREFERENCES }
    expect(withPreference(current, "launchAtLogin", true).launchAtLogin).toBe(true)
    expect(withPreference(current, "showInDock", "false")).toBe(current)
    expect(withPreference(current, "other", true)).toBe(current)
  })
})
