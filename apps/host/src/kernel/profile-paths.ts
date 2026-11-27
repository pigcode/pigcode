/** Profile 目录解析、权限落盘与无窗口 Host 常见 CLI PATH 补全。 */
import { chmodSync, mkdirSync } from "node:fs"
import { homedir } from "node:os"
import { posix, resolve, win32 } from "node:path"

/** 按桌面端约定计算默认 profile 目录，与 Electron `userData/profiles/desktop` 保持一致。 */
export function defaultDesktopProfileDir(
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
  home: string = homedir(),
): string {
  if (platform === "darwin") {
    return posix.join(home, "Library", "Application Support", "Pigcode", "profiles", "desktop")
  }
  if (platform === "win32") {
    const appData = env.APPDATA?.trim() || win32.join(home, "AppData", "Roaming")
    return win32.join(appData, "Pigcode", "profiles", "desktop")
  }
  const configHome = env.XDG_CONFIG_HOME?.trim() || posix.join(home, ".config")
  return posix.join(configHome, "Pigcode", "profiles", "desktop")
}

/** 解析 profile 目录的参数。 */
export interface ResolveProfileDirOptions {
  cliProfileDir?: string | undefined
  env?: NodeJS.ProcessEnv | undefined
  platform?: NodeJS.Platform | undefined
  home?: string | undefined
}

/**
 * 解析最终使用的 profile 目录。
 * 优先级：命令行参数 `cliProfileDir` > 环境变量 `PIGCODE_PROFILE_DIR` > 平台默认桌面目录。
 */
export function resolveProfileDir(options: ResolveProfileDirOptions = {}): string {
  const platform = options.platform ?? process.platform
  const env = options.env ?? process.env
  const home = options.home ?? homedir()
  const pathResolve =
    platform === process.platform ? resolve : platform === "win32" ? win32.resolve : posix.resolve

  const cli = options.cliProfileDir?.trim()
  if (cli) return pathResolve(cli)

  const fromEnv = env.PIGCODE_PROFILE_DIR?.trim()
  if (fromEnv) return pathResolve(fromEnv)

  return defaultDesktopProfileDir(platform, env, home)
}

/**
 * 确保 profile 目录存在；仅在新建时尝试在 POSIX 上收紧为 `0o700`，
 * 只读文件系统或非属主目录的 `EPERM`/`EROFS` 静默忽略。
 */
export function ensureProfileDir(profileDir: string): void {
  const created = mkdirSync(profileDir, { recursive: true, mode: 0o700 })
  if (created === undefined || process.platform === "win32") return
  try {
    chmodSync(profileDir, 0o700)
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code !== "EPERM" && code !== "EROFS") throw error
  }
}

/** 在 POSIX 环境下将常见用户级 CLI 目录补进 `env.PATH`，跳过已有项。 */
export function appendCommonCliPaths(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
  home: string = homedir(),
): void {
  if (platform === "win32") return
  const current = (env.PATH ?? "").split(":").filter(Boolean)
  const seen = new Set(current)
  const additions = [
    posix.join(home, ".local", "bin"),
    posix.join(home, ".npm-global", "bin"),
    "/opt/homebrew/bin",
    "/usr/local/bin",
  ].filter((dir) => {
    if (seen.has(dir)) return false
    seen.add(dir)
    return true
  })
  if (additions.length === 0) return
  env.PATH = [...current, ...additions].join(":")
}
