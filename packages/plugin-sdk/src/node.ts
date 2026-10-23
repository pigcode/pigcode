/**
 * Host 侧 driver 用的 Node 辅助函数：展开 `~`、合并子进程环境变量、在 PATH 与常见安装目录里
 * 查找可执行文件。单独作为 `@pigcode/plugin-sdk/node` 导出，渲染进程不会引入 Node 模块。
 */
import { existsSync, statSync } from "node:fs"
import { homedir } from "node:os"
import { delimiter, isAbsolute, join } from "node:path"
import type { EnvironmentEntry } from "@pigcode/contracts"

/** 把开头的 `~` 展开成用户主目录；其他路径原样返回。 */
export function expandHome(path: string, home: string = homedir()): string {
  if (path === "~") return home
  if (path.startsWith("~/") || path.startsWith("~\\")) return join(home, path.slice(2))
  return path
}

/**
 * 生成子进程环境：继承 base，叠加设置页里的环境变量，再叠加 driver 自己的覆盖项
 * （例如 CODEX_HOME）。覆盖项为 undefined 时不写入，保留继承来的值。
 */
export function providerEnvironment(
  entries: readonly EnvironmentEntry[],
  overrides: Readonly<Record<string, string | undefined>> = {},
  base: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...base }
  for (const entry of entries) env[entry.name] = entry.value
  for (const [name, value] of Object.entries(overrides)) {
    if (value !== undefined) env[name] = value
  }
  return env
}

/**
 * 从 GUI 启动的应用拿不到登录 shell 的 PATH（macOS 尤其如此），
 * 所以除了 PATH 还要看这些常见的 CLI 安装目录。
 */
export function commonBinaryDirs(home: string = homedir()): string[] {
  return [
    join(home, ".local", "bin"),
    join(home, ".bun", "bin"),
    join(home, ".npm-global", "bin"),
    "/opt/homebrew/bin",
    "/usr/local/bin",
  ]
}

/** 当前平台上一个命令可能的文件名；Windows 依次尝试 PATHEXT 里的扩展名。 */
function executableNames(name: string): string[] {
  if (process.platform !== "win32") return [name]
  const extensions = (process.env.PATHEXT ?? ".EXE;.CMD;.BAT").split(";").filter(Boolean)
  return [...extensions.map((extension) => `${name}${extension.toLowerCase()}`), name]
}

/** 路径存在且是文件。 */
function isFile(path: string): boolean {
  try {
    return existsSync(path) && statSync(path).isFile()
  } catch {
    return false
  }
}

/** 在 PATH 与额外目录里查找命令，返回第一个存在的完整路径；找不到时返回 undefined。 */
export function findExecutable(
  name: string,
  extraDirs: readonly string[] = commonBinaryDirs(),
  pathValue: string | undefined = process.env.PATH,
): string | undefined {
  const dirs = [...(pathValue ?? "").split(delimiter), ...extraDirs].filter(Boolean)
  for (const dir of dirs) {
    for (const candidate of executableNames(name)) {
      const path = join(dir, candidate)
      if (isFile(path)) return path
    }
  }
  return undefined
}

/**
 * 决定要启动的可执行文件：用户填了路径就用它（展开 `~`；只写了命令名时在 PATH 里找），
 * 否则在 PATH 与常见目录里找默认命令；都找不到时返回命令名本身，让 spawn 报出明确的错误。
 */
export function resolveExecutable(configured: string | undefined, fallback: string): string {
  if (configured) {
    const expanded = expandHome(configured)
    if (isAbsolute(expanded) || expanded.includes("/") || expanded.includes("\\")) return expanded
    return findExecutable(expanded) ?? expanded
  }
  return findExecutable(fallback) ?? fallback
}
