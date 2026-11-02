/** 把设置页里的值变成启动 `codex app-server` 的命令：可执行文件、参数与环境变量。 */
import {
  settingEnvironment,
  settingString,
  tokenizeCliArgs,
  type AgentSettingsValues,
} from "@pigcode/plugin-sdk"
import { expandHome, agentEnvironment, resolveExecutable } from "@pigcode/plugin-sdk/node"

/** 一次启动 app-server 用到的命令。 */
export interface CodexLaunch {
  command: string
  args: string[]
  /** 没有任何覆盖时为 undefined，子进程继承 Host 的 process.env。 */
  env: NodeJS.ProcessEnv | undefined
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
export function codexLaunch(settings: AgentSettingsValues | undefined): CodexLaunch {
  const entries = settingEnvironment(settings)
  const home = settingString(settings, "homePath")
  return {
    command: codexExecutable(settings),
    args: ["app-server", "--stdio", ...tokenizeCliArgs(settingString(settings, "launchArgs"))],
    env:
      entries.length > 0 || home
        ? agentEnvironment(entries, { CODEX_HOME: home ? expandHome(home) : undefined })
        : undefined,
  }
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
