/**
 * Host 侧 driver 用的 Node 辅助函数：展开 `~`、合并子进程环境变量、在 PATH 与常见安装目录里
 * 查找可执行文件。单独作为 `@pigcode/plugin-sdk/node` 导出，渲染进程不会引入 Node 模块。
 */
import { existsSync, readFileSync, statSync } from "node:fs"
import { homedir } from "node:os"
import { delimiter, dirname, isAbsolute, join, resolve, sep } from "node:path"
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
export function agentEnvironment(
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

/**
 * 在 PATH 与额外目录里查找命令，返回第一个存在的完整路径；找不到时返回 undefined。
 */
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

/** 一次子进程启动的组成：可执行文件、参数前缀与要不要经过 shell。 */
export interface LaunchTarget {
  command: string
  args: string[]
  /** 只在 Windows 上解析失败的批处理才会是 true；其余情况直接启动。 */
  shell: boolean
}

/** 批处理 shim：Windows 上 Node 不能直接 spawn 它们（会报 EINVAL）。 */
const BATCH_FILE = /\.(?:bat|cmd)$/i

/** 会当作脚本用 node 运行的后缀；其他解析结果都按原生可执行文件启动。 */
const SCRIPT_FILE = /\.(?:cjs|js|jsx|mjs|ts|tsx)$/i

/**
 * cmd-shim 生成的脚本里指向真正目标的路径：引号内、以可执行文件或脚本后缀结尾。
 * 取最后一个匹配：带 IF EXIST 的 shim 前面还有一段 "%dp0%\node.exe"。
 */
const SHIM_TARGET = /"([^"\r\n]+\.(?:cjs|exe|js|jsx|mjs|ts|tsx))"/gi

/**
 * cmd-shim 生成脚本的特征：npm/npx 的 dp0 初始化、pnpm 的 node.exe 分支或开头的 @SETLOCAL
 * （pnpm 给 exe 目标生成的 shim 只有这一行和最后的调用）。
 * 手写的包装脚本通常没有这些（例如自己 set 一个代理地址再调 cli.js），不能解包，
 * 否则会跳过包装脚本里的环境变量。@SETLOCAL 只认文件第一行，避免误伤手写脚本。
 */
const GENERATED_SHIM = /^@SETLOCAL|:find_dp0|SET dp0=%~dp0|@IF EXIST "%~dp0\\node\.exe"/i

/**
 * 从 cmd-shim 生成的 .cmd 内容里取出它启动的目标文件；原样返回，可能带 %~dp0 之类的占位符。
 * 找不到时返回 undefined。
 */
export function parseShimTarget(text: string): string | undefined {
  let found: string | undefined
  for (const match of text.matchAll(SHIM_TARGET)) found = match[1]
  return found
}

/**
 * 把 Windows 上的批处理 shim 解析成它实际启动的文件：原生 exe，或由 node 运行的 JS 入口。
 * 只认 cmd-shim 生成的脚本；不是批处理、不是生成的 shim、目标不存在、或路径里还有没法
 * 展开的环境变量时返回 undefined。
 */
export function shimTarget(path: string): string | undefined {
  if (process.platform !== "win32" || !BATCH_FILE.test(path)) return undefined
  let text: string
  try {
    text = readFileSync(path, "utf8")
  } catch {
    return undefined
  }
  if (!GENERATED_SHIM.test(text)) return undefined
  const script = parseShimTarget(text)
  if (!script) return undefined
  // cmd-shim 用 %dp0%，pnpm 的 shim 直接用 %~dp0；两者都指 shim 所在目录，且都带结尾分隔符。
  // 用函数替换，目录名里的 $& 之类不会被当成替换模式。
  const dir = dirname(path)
  const prefix = dir.endsWith(sep) ? dir : `${dir}${sep}`
  const expanded = script.replace(/%~dp0/gi, () => prefix).replace(/%dp0%/gi, () => prefix)
  // 还有别的变量就不猜了：猜错会把调用方指向不存在或不对的文件。
  if (/%[^%\r\n]+%/.test(expanded)) return undefined
  // 相对路径按 shim 所在目录解析，和 cmd 的工作方式一致。
  const target = resolve(dir, expanded)
  return isFile(target) ? target : undefined
}

/**
 * 决定怎样启动一个命令。Windows 上 .cmd/.bat 不能直接 spawn，优先解析后直接启动它的目标：
 * JS 入口交给 node，原生 exe 直接执行，用户给的参数也就不会被 cmd 重新解释。
 * 解析不出来时才退回 shell，并把路径自己加上引号——Node 的 shell 模式只给整条命令加一层引号，
 * 路径里有空格时 cmd 会在第一个空格处断开。
 */
export function launchTarget(command: string, args: readonly string[] = []): LaunchTarget {
  if (process.platform !== "win32" || !BATCH_FILE.test(command)) {
    return { command, args: [...args], shell: false }
  }
  const target = shimTarget(command)
  if (target && SCRIPT_FILE.test(target)) {
    return { command: "node", args: [target, ...args], shell: false }
  }
  if (target) return { command: target, args: [...args], shell: false }
  return { command: `"${command}"`, args: [...args], shell: true }
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
