/** 把设置页里的值变成启动 `codex app-server` 的命令：可执行文件、参数与环境变量。 */
import {
  settingEnvironment,
  settingString,
  tokenizeCliArgs,
  type AgentSettingsValues,
  type AgentInstanceContext,
} from "@pigcode/plugin-sdk"
import type { ManagedCodexRuntime } from "./managed-runtime"
import { prepareShadowHome, shadowCodexHome, sharedCodexHome } from "./shadow-home"
import { expandHome, agentEnvironment, resolveExecutable } from "@pigcode/plugin-sdk/node"

/** 一次启动 app-server 用到的命令。 */
export interface CodexLaunch {
  command: string
  args: string[]
  /** 目录探测在项目中启动，让项目配置与实际会话一致。 */
  cwd?: string | undefined
  /** 没有任何覆盖时为 undefined，子进程继承 Host 的 process.env。 */
  env: NodeJS.ProcessEnv | undefined
  /** 私有 home 的凭据只通过带文件存储覆盖的 app-server 查询。 */
  isolatedAccount?: boolean
}

/** 解析可执行文件：设置页的路径 > PIGCODE_CODEX_PATH > PATH 与常见安装目录。 */
export function codexExecutable(settings: AgentSettingsValues | undefined): string {
  const configured = settingString(settings, "binaryPath")
  if (configured) return resolveExecutable(configured, "codex")
  const fromEnv = process.env.PIGCODE_CODEX_PATH
  if (fromEnv) return fromEnv
  return resolveExecutable(undefined, "codex")
}

/** 根据设置生成 app-server 的启动命令；启动参数追加在 `app-server --stdio` 之后。 */
export function codexLaunch(
  settings: AgentSettingsValues | undefined,
  instance?: AgentInstanceContext,
): CodexLaunch {
  const entries = settingEnvironment(settings)
  const shadow = shadowCodexHome(settings, instance)
  const home = shadow || settingString(settings, "homePath")
  return {
    command: codexExecutable(settings),
    args: [
      "app-server",
      "--stdio",
      ...tokenizeCliArgs(settingString(settings, "launchArgs")),
      ...(shadow ? ["-c", 'cli_auth_credentials_store="file"'] : []),
      ...(settings?.setupMode === "managed"
        ? [
            "-c",
            'forced_login_method="chatgpt"',
            "-c",
            'model_provider="openai"',
            "-c",
            'openai_base_url="https://chatgpt.com/backend-api/codex"',
            "-c",
            'chatgpt_base_url="https://chatgpt.com/backend-api/"',
          ]
        : []),
    ],
    ...(shadow ? { isolatedAccount: true } : {}),
    env:
      entries.length > 0 || home
        ? agentEnvironment(entries, { CODEX_HOME: home ? expandHome(home) : undefined })
        : undefined,
  }
}

export type PrepareCodexLaunch = (
  settings: AgentSettingsValues | undefined,
  instance?: AgentInstanceContext,
  installSignal?: AbortSignal,
) => Promise<CodexLaunch | null>

/** 先解析运行时，再准备私有账号目录。首次下载安装只允许从登录动作触发。 */
export async function prepareCodexLaunch(
  managed: ManagedCodexRuntime,
  settings: AgentSettingsValues | undefined,
  instance?: AgentInstanceContext,
  installSignal?: AbortSignal,
): Promise<CodexLaunch | null> {
  const launch = codexLaunch(settings, instance)
  if (settings?.setupMode === "managed" && instance) {
    const command = await managed.resolve(settings, instance, installSignal)
    if (!command) return null
    launch.command = command
  }
  const shadow = shadowCodexHome(settings, instance)
  if (shadow) await prepareShadowHome(sharedCodexHome(settings), shadow)
  if (settings?.setupMode === "managed" && launch.env) {
    for (const name of Object.keys(launch.env)) {
      if (
        ["OPENAI_API_KEY", "OPENAI_BASE_URL", "CODEX_API_KEY", "CODEX_ACCESS_TOKEN"].includes(
          name.toUpperCase(),
        )
      )
        delete launch.env[name]
    }
  }
  return launch
}

/** 启动命令的指纹：设置改了以后，空闲的 app-server 不再复用，下一次 run 按新设置启动。 */
export function launchKey(launch: CodexLaunch): string {
  const overrides = launch.env
    ? Object.entries(launch.env)
        .filter(([name, value]) => process.env[name] !== value)
        .sort(([left], [right]) => left.localeCompare(right))
    : []
  return JSON.stringify([launch.command, launch.args, overrides])
}
