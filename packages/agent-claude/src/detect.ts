/** 只读检测 Claude Code：版本与 auth status，不触发登录。 */
import { execFile } from "node:child_process"
import { promisify } from "node:util"
import { launchTarget } from "@pigcode/plugin-sdk/node"

const exec = promisify(execFile)

/** 一次 Claude Code 检测的完整结果；失败字段用于界面提示。 */
export interface ClaudeDetection {
  installed: boolean
  command: string
  version: string | null
  loggedIn: boolean
  authMethod: string | null
  subscriptionType: string | null
  /** 登录账号的邮箱；API Key 或第三方云登录时为空。 */
  email?: string | null
  error: string | null
}

/** 检测选项：command 是要探测的可执行文件，env 是启动它时的环境（例如 CLAUDE_CONFIG_DIR）。 */
export interface DetectClaudeOptions {
  command?: string | undefined
  env?: NodeJS.ProcessEnv | undefined
}

/** 运行两个只读命令；超时或非零退出都归为未安装/未登录。 */
export async function detectClaude(options: DetectClaudeOptions = {}): Promise<ClaudeDetection> {
  const command = options.command ?? "claude"
  const base: ClaudeDetection = {
    installed: false,
    command,
    version: null,
    loggedIn: false,
    authMethod: null,
    subscriptionType: null,
    error: null,
  }
  // Windows 上 npm 装的 CLI 是 .cmd；先解析成它实际启动的文件，解析不了才经 shell。
  const target = launchTarget(command)
  const run = (args: string[]) =>
    exec(target.command, [...target.args, ...args], {
      timeout: 5000,
      ...(target.shell ? { shell: true } : {}),
      ...(options.env ? { env: options.env } : {}),
    })
  try {
    const version = await run(["--version"])
    base.installed = true
    base.version = version.stdout.trim()
  } catch (error) {
    base.error = isMissing(error)
      ? `claude executable not found: ${command}`
      : error instanceof Error
        ? error.message
        : String(error)
    return base
  }
  try {
    const status = await run(["auth", "status"])
    const parsed = JSON.parse(status.stdout) as {
      loggedIn?: boolean
      authMethod?: string
      subscriptionType?: string
      email?: string
    }
    base.loggedIn = parsed.loggedIn === true
    base.authMethod = parsed.authMethod ?? null
    base.subscriptionType = parsed.subscriptionType ?? null
    base.email = parsed.loggedIn === true && parsed.email ? parsed.email : null
  } catch (error) {
    base.error = error instanceof Error ? error.message : String(error)
  }
  return base
}

/** spawn 找不到可执行文件。 */
function isMissing(error: unknown): boolean {
  return (
    typeof error === "object" && error !== null && (error as { code?: unknown }).code === "ENOENT"
  )
}
