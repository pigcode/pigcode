/**
 * 从 Dock、Finder 或桌面菜单启动的应用拿不到登录 shell 的环境：PATH 只有系统目录，
 * 用户的 node、nvm、代理和 API key 设置都看不到。npm 装的 Codex 靠 `env node` 启动，这样根本起不来。
 * 所以启动时让登录 shell 跑一次，读出它的环境变量，让 Agent 看到的环境和在终端里一样。
 */
import { spawn, type ChildProcess } from "node:child_process"
import { randomUUID } from "node:crypto"
import { userInfo } from "node:os"

/** 等 shell 的最长时间：窗口也在等它，不能太久。超过就放弃，应用照常用自己的环境。 */
const SHELL_ENV_TIMEOUT_MS = 5000

/** 这些变量描述的是那个 shell 进程本身，带给应用没有意义。 */
const SHELL_ONLY = new Set([
  "_",
  "OLDPWD",
  "PWD",
  "SHLVL",
  "TERM",
  "TERM_PROGRAM",
  "TERM_PROGRAM_VERSION",
])

/**
 * 这些变量会改变应用自己怎么运行，不能让 rc 文件决定：
 * NODE_OPTIONS 里有些选项 Electron 不接受，Host 可能起不来；动态库路径会盖掉 AppImage 自己设的值；
 * PIGCODE_* 是给测试和并排 profile 用的开关，PIGCODE_PROFILE_DIR 还决定了单实例锁。
 */
const APP_OWNED = new Set(["LD_LIBRARY_PATH", "LD_PRELOAD", "NODE_OPTIONS"])
const APP_OWNED_PREFIXES = ["DYLD_", "ELECTRON_", "PIGCODE_"]

/**
 * 从终端启动时已经有完整的环境；Windows 的 GUI 应用本来就继承用户的 PATH。
 * `TERM=linux` 是例外：从 tty 启动的桌面（sway、startx）会把它传下来，但并没有经过登录 shell 的 rc 文件。
 */
export function needsLoginShellEnv(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): boolean {
  return platform !== "win32" && (!env.TERM || env.TERM === "linux")
}

/** 结束 shell 和 rc 文件启动的子进程；它们已经不在时什么也不做。 */
function killGroup(child: ChildProcess): void {
  try {
    if (child.pid) process.kill(-child.pid, "SIGKILL")
  } catch {
    // 进程组已经不在了。
  }
}

/**
 * 运行登录 shell，返回它的环境变量；shell 失败、超时或输出读不懂时返回 null。
 * 用 -i 是因为很多人把 PATH 写在 .zshrc 里。rc 文件可能打印任何内容，所以前后加了随机标记。
 * 读到结束标记就返回，不等输出关闭：rc 文件启动的后台进程会一直占着 stdout。
 */
export function readLoginShellEnv(
  shell: string,
  timeoutMs: number = SHELL_ENV_TIMEOUT_MS,
): Promise<Record<string, string> | null> {
  const mark = randomUUID()
  const command = `printf '%s' '${mark}'; /usr/bin/env -0; printf '%s' '${mark}'`
  return new Promise((resolve) => {
    let child: ChildProcess
    try {
      // 单独一个进程组，放弃时能连 rc 文件启动的子进程一起结束；也不会占用任何终端。
      child = spawn(shell, ["-i", "-l", "-c", command], {
        detached: true,
        stdio: ["ignore", "pipe", "ignore"],
      })
    } catch {
      // 有些错误码（比如路径的一段不是目录）是同步抛出来的。
      resolve(null)
      return
    }
    let output = ""
    let settled = false
    const abandon = (): void => killGroup(child)
    const finish = (value: Record<string, string> | null): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      process.off("exit", abandon)
      resolve(value)
    }
    const timer = setTimeout(() => {
      abandon()
      finish(null)
    }, timeoutMs)
    // 还在等 shell 时应用就退出了，也不能把卡住的 rc 文件留在后台。
    process.once("exit", abandon)
    child.stdout?.setEncoding("utf8")
    child.stdout?.on("data", (chunk: string) => {
      if (settled) return
      output += chunk
      const value = parseMarkedEnv(output, mark)
      if (value) finish(value)
    })
    child.once("error", () => finish(null))
    child.once("close", () => finish(parseMarkedEnv(output, mark)))
  })
}

/** 取出两个标记之间 `env -0` 的输出；结束标记还没到时返回 null。 */
function parseMarkedEnv(output: string, mark: string): Record<string, string> | null {
  const start = output.indexOf(mark)
  if (start < 0) return null
  const end = output.indexOf(mark, start + mark.length)
  if (end < 0) return null
  const env: Record<string, string> = {}
  for (const entry of output.slice(start + mark.length, end).split("\0")) {
    const equals = entry.indexOf("=")
    if (equals > 0) env[entry.slice(0, equals)] = entry.slice(equals + 1)
  }
  return env
}

/** 把 shell 的环境写进目标环境，跳过只属于那个 shell 进程的变量，和应用自己要管的变量。 */
export function mergeShellEnv(target: NodeJS.ProcessEnv, shellEnv: Record<string, string>): void {
  for (const [name, value] of Object.entries(shellEnv)) {
    if (SHELL_ONLY.has(name) || APP_OWNED.has(name)) continue
    if (APP_OWNED_PREFIXES.some((prefix) => name.startsWith(prefix))) continue
    target[name] = value
  }
}

/** 需要时读取登录 shell 的环境并写进 process.env；读不到时什么也不改，应用照常启动。 */
export async function applyLoginShellEnv(): Promise<void> {
  if (!needsLoginShellEnv()) return
  const shell = process.env.SHELL || userInfo().shell
  if (!shell) return
  const shellEnv = await readLoginShellEnv(shell)
  if (shellEnv) mergeShellEnv(process.env, shellEnv)
  else console.warn(`Could not read the environment of the login shell ${shell}`)
}
