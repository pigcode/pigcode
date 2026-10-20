/** 只读检测 Claude Code：版本与 auth status，不触发登录。 */
import { execFile } from "node:child_process"
import { homedir } from "node:os"
import { join } from "node:path"
import { promisify } from "node:util"

const exec = promisify(execFile)

/** 一次 Claude Code 检测的完整结果；失败字段用于 UI 提示。 */
export interface ClaudeDetection {
  installed: boolean
  command: string
  version: string | null
  loggedIn: boolean
  authMethod: string | null
  subscriptionType: string | null
  error: string | null
}

/** 运行两个只读命令；超时或非零退出都归为未安装/未登录。 */
export async function detectClaude(options: { command?: string } = {}): Promise<ClaudeDetection> {
  const candidates = options.command
    ? [options.command]
    : [
        "claude",
        join(homedir(), ".bun/bin/claude"),
        "/opt/homebrew/bin/claude",
        "/usr/local/bin/claude",
      ]
  for (const command of candidates) {
    const detection = await probe(command)
    if (detection.installed) return detection
  }
  return {
    installed: false,
    command: options.command ?? "claude",
    version: null,
    loggedIn: false,
    authMethod: null,
    subscriptionType: null,
    error: "claude executable not found",
  }
}

/** 探测单个候选命令；只有 --version 成功才认为已安装。 */
async function probe(command: string): Promise<ClaudeDetection> {
  const base: ClaudeDetection = {
    installed: false,
    command,
    version: null,
    loggedIn: false,
    authMethod: null,
    subscriptionType: null,
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
    const status = await exec(command, ["auth", "status"], { timeout: 5000 })
    const parsed = JSON.parse(status.stdout) as {
      loggedIn?: boolean
      authMethod?: string
      subscriptionType?: string
    }
    base.loggedIn = parsed.loggedIn === true
    base.authMethod = parsed.authMethod ?? null
    base.subscriptionType = parsed.subscriptionType ?? null
  } catch (error) {
    base.error = error instanceof Error ? error.message : String(error)
  }
  return base
}
