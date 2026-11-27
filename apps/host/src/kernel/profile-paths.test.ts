/** 验证 profile 目录解析、权限创建与常见 CLI PATH 补全。 */
import { chmod, mkdtemp, rm, stat } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, posix, win32 } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import {
  appendCommonCliPaths,
  defaultDesktopProfileDir,
  ensureProfileDir,
  resolveProfileDir,
} from "./profile-paths"

const dirs: string[] = []

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

async function makeTempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "pigcode-profile-paths-"))
  dirs.push(dir)
  return dir
}

describe("defaultDesktopProfileDir", () => {
  it("uses Application Support on darwin", () => {
    expect(defaultDesktopProfileDir("darwin", {}, "/Users/alice")).toBe(
      "/Users/alice/Library/Application Support/Pigcode/profiles/desktop",
    )
  })

  it("uses XDG_CONFIG_HOME or ~/.config on linux", () => {
    expect(
      defaultDesktopProfileDir("linux", { XDG_CONFIG_HOME: "/home/alice/.xdg" }, "/home/alice"),
    ).toBe("/home/alice/.xdg/Pigcode/profiles/desktop")

    expect(defaultDesktopProfileDir("linux", {}, "/home/alice")).toBe(
      "/home/alice/.config/Pigcode/profiles/desktop",
    )

    expect(defaultDesktopProfileDir("linux", { XDG_CONFIG_HOME: "   " }, "/home/alice")).toBe(
      "/home/alice/.config/Pigcode/profiles/desktop",
    )
  })

  it("uses APPDATA on win32 and falls back to AppData/Roaming and XDG defaults", () => {
    expect(
      defaultDesktopProfileDir(
        "win32",
        { APPDATA: "C:\\Users\\alice\\AppData\\Roaming" },
        "C:\\Users\\alice",
      ),
    ).toBe(win32.join("C:\\Users\\alice\\AppData\\Roaming", "Pigcode", "profiles", "desktop"))

    expect(defaultDesktopProfileDir("win32", {}, "C:\\Users\\alice")).toBe(
      win32.join("C:\\Users\\alice", "AppData", "Roaming", "Pigcode", "profiles", "desktop"),
    )

    expect(defaultDesktopProfileDir("freebsd", {}, "/home/alice")).toBe(
      posix.join("/home/alice", ".config", "Pigcode", "profiles", "desktop"),
    )
  })
})

describe("resolveProfileDir", () => {
  it("applies precedence cliProfileDir > PIGCODE_PROFILE_DIR > defaultDesktopProfileDir", () => {
    expect(
      resolveProfileDir({
        cliProfileDir: "/tmp/cli-profile",
        env: { PIGCODE_PROFILE_DIR: "/tmp/env-profile" },
        platform: "darwin",
        home: "/Users/alice",
      }),
    ).toBe("/tmp/cli-profile")

    expect(
      resolveProfileDir({
        cliProfileDir: "   ",
        env: { PIGCODE_PROFILE_DIR: "/tmp/env-profile" },
        platform: "darwin",
        home: "/Users/alice",
      }),
    ).toBe("/tmp/env-profile")

    expect(
      resolveProfileDir({
        env: { PIGCODE_PROFILE_DIR: "  " },
        platform: "darwin",
        home: "/Users/alice",
      }),
    ).toBe("/Users/alice/Library/Application Support/Pigcode/profiles/desktop")
  })
})

describe("ensureProfileDir", () => {
  it("creates nested profile directory with 0700 on POSIX and tolerates existing directories", async () => {
    const root = await makeTempDir()
    const nested = join(root, "nested", "profile")

    ensureProfileDir(nested)
    if (process.platform !== "win32") {
      expect((await stat(nested)).mode & 0o777).toBe(0o700)
    }

    // 已存在的目录不会抛错，也不会强制覆盖已有权限。
    if (process.platform !== "win32") {
      await chmod(nested, 0o750)
    }
    expect(() => ensureProfileDir(nested)).not.toThrow()
    if (process.platform !== "win32") {
      expect((await stat(nested)).mode & 0o777).toBe(0o750)
    }
  })
})

describe("appendCommonCliPaths", () => {
  it("appends common CLI directories without duplicating existing PATH entries", () => {
    const env: NodeJS.ProcessEnv = {
      PATH: "/usr/bin:/opt/homebrew/bin:/Users/alice/.local/bin",
    }

    appendCommonCliPaths(env, "darwin", "/Users/alice")

    expect(env.PATH?.split(":")).toEqual([
      "/usr/bin",
      "/opt/homebrew/bin",
      "/Users/alice/.local/bin",
      "/Users/alice/.npm-global/bin",
      "/usr/local/bin",
    ])
  })

  it("populates PATH when missing and skips win32", () => {
    const emptyEnv: NodeJS.ProcessEnv = {}
    appendCommonCliPaths(emptyEnv, "linux", "/home/alice")
    expect(emptyEnv.PATH?.split(":")).toEqual([
      "/home/alice/.local/bin",
      "/home/alice/.npm-global/bin",
      "/opt/homebrew/bin",
      "/usr/local/bin",
    ])

    const winEnv: NodeJS.ProcessEnv = { PATH: "C:\\Windows\\System32" }
    appendCommonCliPaths(winEnv, "win32", "C:\\Users\\alice")
    expect(winEnv.PATH).toBe("C:\\Windows\\System32")
  })
})
