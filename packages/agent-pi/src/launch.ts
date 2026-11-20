import { execFile } from "node:child_process"
import { tmpdir } from "node:os"
import { promisify } from "node:util"
import { join, resolve } from "node:path"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import {
  settingEnvironment,
  settingString,
  tokenizeCliArgs,
  type AgentSettingsValues,
} from "@pigcode/plugin-sdk"
import {
  agentEnvironment,
  expandHome,
  findExecutable,
  launchTarget,
  cliVersion,
} from "@pigcode/plugin-sdk/node"

const exec = promisify(execFile)
const reserved = new Set([
  "--mode",
  "--continue",
  "-c",
  "--resume",
  "-r",
  "--export",
  "--fork",
  "--help",
  "-h",
  "--list-models",
  "--no-session",
  "--print",
  "-p",
  "--session",
  "--session-id",
  "--version",
  "-v",
  "--",
])
const withValue = new Set([
  "--api-key",
  "--append-system-prompt",
  "--exclude-tools",
  "-xt",
  "--extension",
  "-e",
  "--model",
  "--models",
  "--name",
  "-n",
  "--prompt-template",
  "--provider",
  "--session-dir",
  "--skill",
  "--system-prompt",
  "--theme",
  "--thinking",
  "--tools",
  "-t",
  "--tui-mode",
  "--use-theme",
])
const switches = new Set([
  "--approve",
  "-a",
  "--no-approve",
  "-na",
  "--no-builtin-tools",
  "-nbt",
  "--no-context-files",
  "-nc",
  "--no-extensions",
  "-ne",
  "--no-prompt-templates",
  "-np",
  "--no-skills",
  "-ns",
  "--no-tools",
  "-nt",
  "--no-themes",
  "--offline",
  "--verbose",
])

/** 启动参数只描述 CLI 选项，RPC 模式、会话及提示词由 Host 管理。 */
export function piArgs(raw: string | undefined, discovery: boolean) {
  const tokens = tokenizeCliArgs(raw).flatMap((token) => {
    const equals = token.indexOf("="),
      key = token.slice(0, equals)
    return equals > 0 && withValue.has(key) ? [key, token.slice(equals + 1)] : [token]
  })
  const args: string[] = []
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i]!,
      key = token.split("=", 1)[0]!
    if (reserved.has(key) || !token.startsWith("-"))
      throw new Error("Pi launch arguments cannot override the RPC session or supply a prompt")
    const skip = discovery && ["--approve", "-a"].includes(key)
    if (!skip) args.push(token)
    if (withValue.has(key)) {
      const value = tokens[++i]
      if (value === undefined || reserved.has(value))
        throw new Error("Pi launch argument requires a value: " + key)
      if (!skip) args.push(value)
    } else if (!switches.has(token) && !token.includes("=")) {
      if (!token.startsWith("--")) throw new Error("Unrecognized Pi launch option: " + key)
      const next = tokens[i + 1]
      if (next && !next.startsWith("-") && !next.startsWith("@")) args.push(tokens[++i]!)
    }
  }
  return args
}

export function piCommand(settings: AgentSettingsValues) {
  const env = agentEnvironment(settingEnvironment(settings))
  const path = expandHome(settingString(settings, "binaryPath") ?? "pi")
  const command = /[/\\]/.test(path)
    ? resolve(path)
    : (findExecutable(path, undefined, env.PATH) ?? path)
  return { command, env }
}

export function piLaunch(settings: AgentSettingsValues, discovery = false) {
  const { command, env } = piCommand(settings)
  const args = ["--mode", "rpc", ...piArgs(settingString(settings, "launchArgs"), discovery)]
  if (discovery) args.push("--no-session", "--offline", "--no-tools", "--no-approve")
  return { command, args, env }
}

export async function piVersion(command: string, env: NodeJS.ProcessEnv) {
  const target = launchTarget(command, ["--version"])
  if (target.shell) return null
  try {
    const { stdout, stderr } = await exec(target.command, target.args, {
      env,
      cwd: tmpdir(),
      timeout: 8_000,
      maxBuffer: 128_000,
      windowsHide: true,
    })
    return cliVersion(stdout + "\n" + stderr)
  } catch {
    return null
  }
}

const extension = `export default function (pi) {
  const policy = process.env.PIGCODE_PI_POLICY
  const ready = process.env.PIGCODE_PI_READY
  const mcp = process.env.PIGCODE_PI_MCP
  delete process.env.PIGCODE_PI_MCP
  if (mcp) pi.registerMcpServer("pigcode", { ...JSON.parse(mcp), exposure: "direct" })
  pi.on("tool_call", async (event, ctx) => {
    if (policy === "full-access") return
    const name = event.toolName
    const builtin = pi.getAllTools().find(tool => tool.name === name)?.sourceInfo?.source === "builtin"
    if (builtin && ["read","grep","find","ls","tool_search"].includes(name)) return
    if (builtin && policy === "auto-accept-edits" && ["edit","write"].includes(name)) return
    try {
      const input = JSON.stringify(event.input) || "{}"
      const message = input.length > 16000 ? input.slice(0,16000) + "…" : input
      if (await ctx.ui.confirm("Allow " + name + "?", message, { signal: ctx.signal })) return
    } catch {}
    return {block:true,reason:"Declined in Pigcode"}
  })
  pi.on("session_start", (_event, ctx) => ctx.ui.notify(ready,"info"))
}`

export async function writePiExtension() {
  const directory = await mkdtemp(join(tmpdir(), "pigcode-pi-extension-"))
  const file = join(directory, "pigcode.mjs")
  try {
    await writeFile(file, extension, { mode: 0o600, flag: "wx" })
    return { directory, file }
  } catch (error) {
    await rm(directory, { recursive: true, force: true })
    throw error
  }
}
