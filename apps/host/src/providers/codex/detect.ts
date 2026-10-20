/** 只读检测 Codex CLI：版本与登录状态，不触发登录。 */
import { execFile } from "node:child_process"
import { homedir } from "node:os"
import { join } from "node:path"
import { promisify } from "node:util"

const exec = promisify(execFile)

/** 一次 Codex 检测的完整结果；失败字段用于 UI 提示。 */
export interface CodexDetection {
  installed: boolean
  command: string
  version: string | null
  loggedIn: boolean
  error: string | null
}

/** 运行两个只读命令；超时或非零退出都归为未安装/未登录。 */
export async function detectCodex(options: { command?: string } = {}): Promise<CodexDetection> {
  const candidates = options.command
    ? [options.command]
    : [
        "codex",
        join(homedir(), ".bun/bin/codex"),
        "/opt/homebrew/bin/codex",
        "/usr/local/bin/codex",
      ]
  for (const command of candidates) {
    const detection = await probe(command)
    if (detection.installed) return detection
  }
  return {
    installed: false,
    command: options.command ?? "codex",
    version: null,
    loggedIn: false,
    error: "codex executable not found",
  }
}

/** 探测单个候选命令；只有 --version 成功才认为已安装。 */
async function probe(command: string): Promise<CodexDetection> {
  const base: CodexDetection = {
    installed: false,
    command,
    version: null,
    loggedIn: false,
    error: null,
  }
  try {
    const version = await exec(command, ["--version"], { timeout: 5000 })
    base.installed = true
    base.version = version.stdout.trim()
  } catch (error) {
    base.error = error instanceof Error ? error.message : String(error)
    return base
  }
  try {
    const status = await exec(command, ["login", "status"], { timeout: 5000 })
    base.loggedIn = parseLoginStatus(status.stdout)
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

/** 从 execFile 错误中取回 stdout/stderr，用于判断未登录状态。 */
function commandOutput(error: unknown): string {
  if (typeof error !== "object" || error === null) return ""
  const record = error as Record<string, unknown>
  const stdout = typeof record.stdout === "string" ? record.stdout : ""
  const stderr = typeof record.stderr === "string" ? record.stderr : ""
  return `${stdout}\n${stderr}`
}
