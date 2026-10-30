/** 验证打开项目文件夹前的路径校验、应用检测与各平台的启动命令。 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { delimiter, join } from "node:path"
import { afterAll, describe, expect, it } from "vitest"
import { appDefsFor, detectApps, findOnPath, type DetectedApp } from "./open-apps"
import { launchCommand, readDirectory, readExistingPath, settleOpenPath } from "./open-in"

const folder = mkdtempSync(join(tmpdir(), "pigcode-open-in-"))
const file = join(folder, "notes.txt")
writeFileSync(file, "")

afterAll(() => rmSync(folder, { recursive: true, force: true }))

/** 按 id 取某个平台的检测结果。 */
function detected(platform: NodeJS.Platform, id: string, location: string): DetectedApp {
  const def = appDefsFor(platform).find((item) => item.id === id)
  if (!def) throw new Error(`no app ${id} on ${platform}`)
  return { def, location }
}

describe("readDirectory", () => {
  it("accepts only existing absolute directories", () => {
    expect(readDirectory(folder)).toBe(folder)
    expect(readDirectory(file)).toBeNull()
    expect(readDirectory(join(folder, "missing"))).toBeNull()
    expect(readDirectory("relative/path")).toBeNull()
    expect(readDirectory(42)).toBeNull()
  })
})

describe("readExistingPath", () => {
  it("accepts existing absolute files and folders only", () => {
    expect(readExistingPath(folder)).toBe(folder)
    expect(readExistingPath(file)).toBe(file)
    expect(readExistingPath(join(folder, "missing"))).toBeNull()
    expect(readExistingPath("relative/path")).toBeNull()
    expect(readExistingPath(null)).toBeNull()
  })
})

describe("settleOpenPath", () => {
  it("passes on the system's answer, and treats no answer as opened", async () => {
    await expect(settleOpenPath(Promise.resolve(""), 50)).resolves.toBe("")
    await expect(settleOpenPath(Promise.resolve("No application found"), 50)).resolves.toBe(
      "No application found",
    )
    await expect(settleOpenPath(new Promise<string>(() => undefined), 20)).resolves.toBe("")
  })
})

describe("detectApps", () => {
  it("lists the macOS apps whose bundles exist, file manager first", () => {
    const installed = new Set([
      "/System/Library/CoreServices/Finder.app",
      "/Applications/Cursor.app",
      "/Applications/Trae CN.app",
      "/Applications/Zed.app",
      "/Applications/CodeBuddy.app",
      "/System/Applications/Utilities/Terminal.app",
      "/Applications/iTerm.app",
      "/Applications/Ghostty.app",
    ])
    const apps = detectApps(appDefsFor("darwin"), (path) => installed.has(path), "")
    expect(apps.map((app) => app.def.name)).toEqual([
      "Finder",
      "Cursor",
      "Trae",
      "Zed",
      "CodeBuddy",
      "Terminal",
      "iTerm",
      "Ghostty",
    ])
    expect(apps.find((app) => app.def.id === "trae")?.location).toBe("/Applications/Trae CN.app")
  })

  it("finds Linux apps on PATH and always offers the file manager", () => {
    // PATH 分隔符和路径拼接跟随运行测试的平台，Windows 上也能模拟 Linux 的 PATH。
    const code = join("/usr/bin", "code")
    const ghostty = join("/opt/bin", "ghostty")
    const onPath = new Set([code, ghostty])
    const searchPath = ["/usr/bin", "/opt/bin"].join(delimiter)
    const apps = detectApps(appDefsFor("linux"), (path) => onPath.has(path), searchPath)
    expect(apps.map((app) => [app.def.id, app.location])).toEqual([
      ["file-manager", ""],
      ["vscode", code],
      ["ghostty", ghostty],
    ])
    expect(findOnPath("missing", "/usr/bin", () => false)).toBeNull()
  })
})

describe("launchCommand", () => {
  it("hands file managers to the shell and opens other apps with the folder", () => {
    expect(
      launchCommand(
        detected("darwin", "finder", "/System/Library/CoreServices/Finder.app"),
        "/w",
        "darwin",
      ),
    ).toBeNull()
    expect(
      launchCommand(
        detected("darwin", "ghostty", "/Applications/Ghostty.app"),
        "/w/my app",
        "darwin",
      ),
    ).toEqual({
      command: "open",
      args: ["-a", "/Applications/Ghostty.app", "/w/my app"],
    })
    expect(
      launchCommand(detected("linux", "gnome-terminal", "/usr/bin/gnome-terminal"), "/w", "linux"),
    ).toEqual({
      command: "/usr/bin/gnome-terminal",
      args: ["--working-directory=/w"],
    })
    expect(launchCommand(detected("linux", "vscode", "/usr/bin/code"), "/w", "linux")).toEqual({
      command: "/usr/bin/code",
      args: ["/w"],
    })
    const wt = launchCommand(
      detected("win32", "windows-terminal", "C:\\wt.exe"),
      "C:\\work\\app",
      "win32",
    )
    expect(wt).toEqual({ command: "C:\\wt.exe", args: ["-d", "C:\\work\\app"] })
    const powershell = launchCommand(
      detected("win32", "powershell", "C:\\ps.exe"),
      "C:\\it's",
      "win32",
    )
    expect(powershell?.args.at(-1)).toBe("Set-Location -LiteralPath 'C:\\it''s'")
  })
})
