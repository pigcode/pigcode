/** 只读检测 Codex CLI：版本与登录状态，不触发登录。 */
import { execFile } from "node:child_process"
import { promisify } from "node:util"

const exec = promisify(execFile)

/** 一次 Codex 检测的完整结果；失败字段用于界面提示。 */
export interface CodexDetection {
  installed: boolean
  command: string
  version: string | null
  loggedIn: boolean
  /** `codex login status` 的说明，例如「Logged in using ChatGPT」。 */
  account: string | null
  error: string | null
}

/** 检测选项：command 是要探测的可执行文件，env 是启动它时的环境（例如 CODEX_HOME）。 */
export interface DetectCodexOptions {
  command?: string | undefined
  env?: NodeJS.ProcessEnv | undefined
}

/** 运行两个只读命令；超时或非零退出都归为未安装/未登录。 */
export async function detectCodex(options: DetectCodexOptions = {}): Promise<CodexDetection> {
  const command = options.command ?? "codex"
  const base: CodexDetection = {
    installed: false,
    command,
    version: null,
    loggedIn: false,
    account: null,
    error: null,
  }
  const run = (args: string[]) =>
    exec(command, args, { timeout: 5000, ...(options.env ? { env: options.env } : {}) })
  try {
    const version = await run(["--version"])
    base.installed = true
    base.version = version.stdout.trim()
  } catch (error) {
    base.error = isMissing(error)
      ? `codex executable not found: ${command}`
      : error instanceof Error
        ? error.message
        : String(error)
    return base
  }
  try {
    const status = await run(["login", "status"])
    base.loggedIn = parseLoginStatus(status.stdout)
    base.account = base.loggedIn ? firstLine(status.stdout) : null
  } catch (error) {
    // `login status` 未登录时可能以非零退出；输出仍可判定为未登录，不算检测失败。
    const output = commandOutput(error)
    base.loggedIn = parseLoginStatus(output)
    if (!/not logged in/i.test(output)) {
      base.error = error instanceof Error ? error.message : String(error)
    }
  }
  return base
}

/** 把 `codex login status` 的文本输出收窄为布尔值。 */
function parseLoginStatus(output: string): boolean {
  return /logged in/i.test(output) && !/not logged in/i.test(output)
}

/** 输出的第一行非空文字。 */
function firstLine(output: string): string | null {
  return (
    output
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find(Boolean) ?? null
  )
}

/** 从 execFile 错误中取回 stdout/stderr，用于判断未登录状态。 */
function commandOutput(error: unknown): string {
  if (typeof error !== "object" || error === null) return ""
  const record = error as Record<string, unknown>
  const stdout = typeof record.stdout === "string" ? record.stdout : ""
  const stderr = typeof record.stderr === "string" ? record.stderr : ""
  return `${stdout}\n${stderr}`
}

/** spawn 找不到可执行文件。 */
function isMissing(error: unknown): boolean {
  return (
    typeof error === "object" && error !== null && (error as { code?: unknown }).code === "ENOENT"
  )
}
