/** 把设置页里的值变成启动 Claude Code 的参数：可执行文件、环境变量与额外的 CLI 选项。 */
import { homedir } from "node:os"
import { join } from "node:path"
import {
  parseCliArgs,
  settingEnvironment,
  settingString,
  type AgentSettingsValues,
} from "@pigcode/plugin-sdk"
import {
  commonBinaryDirs,
  expandHome,
  findExecutable,
  agentEnvironment,
  resolveExecutable,
  shimTarget,
} from "@pigcode/plugin-sdk/node"

/**
 * 这些选项由 Pigcode 自己决定（权限模式、会话恢复、模型与输出格式），
 * 写在启动参数里也不会传给 CLI，免得和界面上的选择互相矛盾。
 */
const MANAGED_FLAGS = new Set([
  "permission-mode",
  "dangerously-skip-permissions",
  "allow-dangerously-skip-permissions",
  "resume",
  "continue",
  "fork-session",
  "session-id",
  "model",
  "print",
  "output-format",
  "input-format",
])

/** 一次启动 Claude Code 用到的参数。 */
export interface ClaudeLaunch {
  /** 找不到时为 undefined，交给 SDK 自己解析。 */
  executable: string | undefined
  /** 没有任何覆盖时为 undefined，SDK 使用 Host 的 process.env。 */
  env: NodeJS.ProcessEnv | undefined
  extraArgs: Record<string, string | null>
}

/** 旧版本地安装器把 CLI 放在这里；新版装在 ~/.local/bin，已在常见目录里。 */
function claudeBinaryDirs(): string[] {
  return [...commonBinaryDirs(), join(homedir(), ".claude", "local")]
}

/**
 * 解析可执行文件：设置页的路径 > PIGCODE_CLAUDE_PATH > PATH 与常见安装目录。
 * 打包后的 Host 不在 SDK 包内，SDK 按自身路径找不到原生二进制，所以要先替它找好。
 */
export function claudeExecutable(settings: AgentSettingsValues | undefined): string | undefined {
  const configured = settingString(settings, "binaryPath")
  if (configured) return resolveExecutable(configured, "claude")
  const fromEnv = process.env.PIGCODE_CLAUDE_PATH
  if (fromEnv) return fromEnv
  return findExecutable("claude", claudeBinaryDirs())
}

/** 根据设置生成启动参数；fixedExecutable 由测试与冒烟传入，优先于设置。 */
export function claudeLaunch(
  settings: AgentSettingsValues | undefined,
  fixedExecutable?: string,
): ClaudeLaunch {
  const entries = settingEnvironment(settings)
  const configDir = settingString(settings, "configDir")
  const env =
    entries.length > 0 || configDir
      ? agentEnvironment(entries, {
          CLAUDE_CONFIG_DIR: configDir ? expandHome(configDir) : undefined,
        })
      : undefined
  const { flags } = parseCliArgs(settingString(settings, "launchArgs"))
  const extraArgs = Object.fromEntries(
    Object.entries(flags).filter(([flag]) => !MANAGED_FLAGS.has(flag)),
  )
  return { executable: fixedExecutable ?? claudeExecutable(settings), env, extraArgs }
}

/** SDK 当作脚本用 node 运行的后缀；其余交给它的路径都必须是原生二进制。 */
const SDK_SCRIPT = /\.(?:js|jsx|mjs|ts|tsx)$/i

/**
 * 交给 SDK 的可执行文件。SDK 只能启动原生二进制或上表里的脚本（后者用 node 运行），
 * 而 Windows 上 npm 装的 claude 是 .cmd shim，这里换成它实际启动的文件（当前的 npm 包是
 * bin/claude.exe）；解析不出来时保持原样，让 SDK 报出它自己的错误。
 */
export function sdkExecutable(executable: string | undefined): string | undefined {
  if (!executable) return undefined
  const target = shimTarget(executable)
  if (target && (/\.exe$/i.test(target) || SDK_SCRIPT.test(target))) return target
  return executable
}
